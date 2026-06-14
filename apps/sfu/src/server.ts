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
const announcedIps = (process.env.MEDIASOUP_ANNOUNCED_IPS ?? announcedIp ?? '')
  .split(',')
  .map((ip) => ip.trim())
  .filter(Boolean);
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
    listenIps: announcedIps.length > 0 ? announcedIps.map((ip) => ({ ip: listenIp, announcedIp: ip })) : [{ ip: listenIp }],
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

function roomsSnapshot() {
  return [...rooms.values()].map((room) => ({
    id: room.id,
    peers: [...room.peers.values()].map((peer) => ({
      id: peer.id,
      username: peer.username,
      transports: peer.transports.size,
      producers: [...peer.producers.values()].map((producer) => ({
        id: producer.id,
        kind: producer.kind,
        appData: producer.appData,
      })),
      consumers: [...peer.consumers.values()].map((consumer) => ({
        id: consumer.id,
        producerId: consumer.producerId,
        kind: consumer.kind,
        paused: consumer.paused,
      })),
    })),
  }));
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
app.get('/rooms', (_req, res) => res.json({ rooms: roomsSnapshot() }));

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
      console.log('peer joined', { roomId: currentRoom.id, peerId: peer.id, username: peer.username });

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

      transport.on('icestatechange', (iceState) => {
        console.log('transport ice state', { roomId: currentRoom?.id, peerId: peer.id, transportId: transport.id, iceState });
      });
      transport.on('iceselectedtuplechange', (tuple) => {
        console.log('transport selected tuple', { roomId: currentRoom?.id, peerId: peer.id, transportId: transport.id, tuple });
      });
      transport.on('dtlsstatechange', (dtlsState) => {
        console.log('transport dtls state', { roomId: currentRoom?.id, peerId: peer.id, transportId: transport.id, dtlsState });
      });

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
      console.log('producer created', {
        roomId: currentRoom.id,
        peerId: peer.id,
        producerId: producer.id,
        kind: producer.kind,
        appData: producer.appData,
      });

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
      console.log('consumer created', {
        roomId: currentRoom.id,
        peerId: peer.id,
        consumerId: consumer.id,
        producerId,
        kind: consumer.kind,
      });
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
      console.log('consumer resumed', { roomId: currentRoom?.id, peerId: socket.id, consumerId });
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
    console.log('peer disconnected', { roomId: currentRoom?.id, peerId: socket.id });
    if (currentRoom) removePeer(currentRoom, socket.id);
  });
});

await createWorker();
server.listen(port, '0.0.0.0', () => {
  console.log(`SFU listening on ${port}`);
});
