import cors from 'cors';
import express from 'express';
import http from 'node:http';
import { Server } from 'socket.io';
import * as mediasoup from 'mediasoup';
import type {
  Consumer,
  Producer,
  Router,
  RtpCapabilities,
  WebRtcTransport,
  Worker,
} from 'mediasoup/types';

const port = Number(process.env.PORT ?? 4000);
const corsOrigins = (process.env.CORS_ORIGINS ?? process.env.CORS_ORIGIN ?? 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const listenIp = process.env.MEDIASOUP_LISTEN_IP ?? '0.0.0.0';
const announcedIp = process.env.MEDIASOUP_ANNOUNCED_IP || undefined;
const minPort = Number(process.env.MEDIASOUP_MIN_PORT ?? 40000);
const maxPort = Number(process.env.MEDIASOUP_MAX_PORT ?? 40100);

const mediaCodecs = [
  {
    kind: 'audio' as const,
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: 'video' as const,
    mimeType: 'video/VP9',
    clockRate: 90000,
    parameters: {
      'profile-id': 2,
      'x-google-start-bitrate': 2500,
    },
  },
  {
    kind: 'video' as const,
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '42e01f',
      'level-asymmetry-allowed': 1,
      'x-google-start-bitrate': 2500,
    },
  },
  {
    kind: 'video' as const,
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: {
      'x-google-start-bitrate': 1800,
    },
  },
];

type Peer = {
  id: string;
  username: string;
  transports: Map<string, WebRtcTransport>;
  producers: Map<string, Producer>;
  consumers: Map<string, Consumer>;
};

type Room = {
  id: string;
  router: Router;
  peers: Map<string, Peer>;
};

const rooms = new Map<string, Room>();
let worker: Worker;

async function createWorker() {
  worker = await mediasoup.createWorker({
    rtcMinPort: minPort,
    rtcMaxPort: maxPort,
  });

  worker.on('died', () => {
    console.error('mediasoup worker died, exiting');
    process.exit(1);
  });
}

async function getRoom(roomId: string) {
  const existing = rooms.get(roomId);
  if (existing) return existing;

  const router = await worker.createRouter({ mediaCodecs });
  const room = { id: roomId, router, peers: new Map<string, Peer>() };
  rooms.set(roomId, room);
  return room;
}

async function createWebRtcTransport(router: Router) {
  const transport = await router.createWebRtcTransport({
    listenIps: [{ ip: listenIp, announcedIp }],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 8_000_000,
  });

  await transport.setMaxIncomingBitrate(10_000_000);
  return transport;
}

function transportPayload(transport: WebRtcTransport) {
  return {
    id: transport.id,
    iceParameters: transport.iceParameters,
    iceCandidates: transport.iceCandidates,
    dtlsParameters: transport.dtlsParameters,
  };
}

function removePeer(room: Room, peerId: string) {
  const peer = room.peers.get(peerId);
  if (!peer) return;

  for (const consumer of peer.consumers.values()) consumer.close();
  for (const producer of peer.producers.values()) producer.close();
  for (const transport of peer.transports.values()) transport.close();

  room.peers.delete(peerId);
  if (room.peers.size === 0) {
    room.router.close();
    rooms.delete(room.id);
  }
}

const app = express();
app.use(cors({ origin: corsOrigins }));
app.get('/health', (_req, res) => res.json({ ok: true, service: 'sfu' }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: corsOrigins, methods: ['GET', 'POST'] },
});

io.on('connection', (socket) => {
  let currentRoom: Room | undefined;

  socket.on('joinRoom', async ({ roomId, username }, callback) => {
    try {
      currentRoom = await getRoom(String(roomId));
      const peer: Peer = {
        id: socket.id,
        username: String(username || 'Invitado'),
        transports: new Map(),
        producers: new Map(),
        consumers: new Map(),
      };

      currentRoom.peers.set(socket.id, peer);
      socket.join(currentRoom.id);

      const existingProducers = [...currentRoom.peers.values()]
        .filter((roomPeer) => roomPeer.id !== socket.id)
        .flatMap((roomPeer) =>
          [...roomPeer.producers.values()].map((producer) => ({
            producerId: producer.id,
            peerId: roomPeer.id,
            username: roomPeer.username,
            kind: producer.kind,
            appData: producer.appData,
          })),
        );

      callback({
        routerRtpCapabilities: currentRoom.router.rtpCapabilities,
        existingProducers,
      });
    } catch (error) {
      callback({ error: error instanceof Error ? error.message : 'join failed' });
    }
  });

  socket.on('createWebRtcTransport', async (_payload, callback) => {
    try {
      if (!currentRoom) throw new Error('room not joined');
      const peer = currentRoom.peers.get(socket.id);
      if (!peer) throw new Error('peer not found');

      const transport = await createWebRtcTransport(currentRoom.router);
      peer.transports.set(transport.id, transport);
      callback(transportPayload(transport));
    } catch (error) {
      callback({ error: error instanceof Error ? error.message : 'transport failed' });
    }
  });

  socket.on('connectTransport', async ({ transportId, dtlsParameters }, callback) => {
    try {
      const peer = currentRoom?.peers.get(socket.id);
      const transport = peer?.transports.get(transportId);
      if (!transport) throw new Error('transport not found');
      await transport.connect({ dtlsParameters });
      callback({ connected: true });
    } catch (error) {
      callback({ error: error instanceof Error ? error.message : 'connect failed' });
    }
  });

  socket.on('produce', async ({ transportId, kind, rtpParameters, appData }, callback) => {
    try {
      if (!currentRoom) throw new Error('room not joined');
      const peer = currentRoom.peers.get(socket.id);
      const transport = peer?.transports.get(transportId);
      if (!peer || !transport) throw new Error('transport not found');

      const producer = await transport.produce({ kind, rtpParameters, appData });
      peer.producers.set(producer.id, producer);

      producer.on('transportclose', () => peer.producers.delete(producer.id));
      producer.observer.on('close', () => {
        peer.producers.delete(producer.id);
        socket.to(currentRoom!.id).emit('producerClosed', { producerId: producer.id });
      });

      socket.to(currentRoom.id).emit('newProducer', {
        producerId: producer.id,
        peerId: socket.id,
        username: peer.username,
        kind: producer.kind,
        appData: producer.appData,
      });

      callback({ id: producer.id });
    } catch (error) {
      callback({ error: error instanceof Error ? error.message : 'produce failed' });
    }
  });

  socket.on('consume', async ({ transportId, producerId, rtpCapabilities }, callback) => {
    try {
      if (!currentRoom) throw new Error('room not joined');
      if (!currentRoom.router.canConsume({ producerId, rtpCapabilities: rtpCapabilities as RtpCapabilities })) {
        throw new Error('cannot consume producer');
      }

      const peer = currentRoom.peers.get(socket.id);
      const transport = peer?.transports.get(transportId);
      if (!peer || !transport) throw new Error('transport not found');

      const consumer = await transport.consume({
        producerId,
        rtpCapabilities,
        paused: true,
      });

      peer.consumers.set(consumer.id, consumer);
      consumer.on('transportclose', () => peer.consumers.delete(consumer.id));
      consumer.on('producerclose', () => {
        peer.consumers.delete(consumer.id);
        socket.emit('producerClosed', { producerId });
      });

      callback({
        id: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
      });
    } catch (error) {
      callback({ error: error instanceof Error ? error.message : 'consume failed' });
    }
  });

  socket.on('resumeConsumer', async ({ consumerId }, callback) => {
    try {
      const consumer = currentRoom?.peers.get(socket.id)?.consumers.get(consumerId);
      if (!consumer) throw new Error('consumer not found');
      await consumer.resume();
      callback({ resumed: true });
    } catch (error) {
      callback({ error: error instanceof Error ? error.message : 'resume failed' });
    }
  });

  socket.on('closeProducer', ({ producerId }, callback) => {
    const producer = currentRoom?.peers.get(socket.id)?.producers.get(producerId);
    producer?.close();
    callback?.({ closed: true });
  });

  socket.on('disconnect', () => {
    if (currentRoom) removePeer(currentRoom, socket.id);
  });
});

await createWorker();
server.listen(port, '0.0.0.0', () => {
  console.log(`SFU listening on ${port}`);
});
