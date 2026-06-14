import { useEffect, useRef, useState } from 'react';
import { Device } from 'mediasoup-client';
import type { Consumer, Producer, Transport } from 'mediasoup-client/types';
import { io, type Socket } from 'socket.io-client';
import { Copy, Maximize2, Mic, MicOff, MonitorUp, PhoneOff, Plus, Users } from 'lucide-react';
import { Button } from './components/ui/button';
import { Card } from './components/ui/card';
import { Input } from './components/ui/input';

const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

type RemoteTrack = {
  id: string;
  producerId: string;
  username: string;
  kind: 'audio' | 'video';
  stream: MediaStream;
};

type ProducerInfo = {
  producerId: string;
  username: string;
  kind: 'audio' | 'video';
  appData?: Record<string, unknown>;
};

function currentRoomId() {
  const match = window.location.pathname.match(/^\/r\/([^/]+)/);
  return match?.[1] ?? '';
}

function request<T>(socket: Socket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    socket.emit(event, payload, (response: T & { error?: string }) => {
      if (response?.error) reject(new Error(response.error));
      else resolve(response);
    });
  });
}

function selectScreenCodec(device: Device) {
  const codecs = device.rtpCapabilities.codecs ?? [];
  return (
    codecs.find((codec) => codec.mimeType.toLowerCase() === 'video/vp9') ??
    codecs.find((codec) => codec.mimeType.toLowerCase() === 'video/h264') ??
    codecs.find((codec) => codec.mimeType.toLowerCase() === 'video/vp8')
  );
}

export function App() {
  const [roomId, setRoomId] = useState(currentRoomId());
  const [username, setUsername] = useState('');
  const [joined, setJoined] = useState(false);
  const [joining, setJoining] = useState(false);
  const [status, setStatus] = useState('Listo para crear o unirte a una sala.');
  const [remoteTracks, setRemoteTracks] = useState<RemoteTrack[]>([]);
  const [localScreen, setLocalScreen] = useState<MediaStream | null>(null);
  const [micEnabled, setMicEnabled] = useState(false);
  const [screenEnabled, setScreenEnabled] = useState(false);

  const socketRef = useRef<Socket | null>(null);
  const deviceRef = useRef<Device | null>(null);
  const sendTransportRef = useRef<Transport | null>(null);
  const recvTransportRef = useRef<Transport | null>(null);
  const producersRef = useRef<Map<string, Producer>>(new Map());
  const consumersRef = useRef<Map<string, Consumer>>(new Map());

  async function createMeeting() {
    const response = await fetch(`${apiUrl}/meetings`, { method: 'POST' });
    const meeting = await response.json();
    window.history.pushState({}, '', `/r/${meeting.roomId}`);
    setRoomId(meeting.roomId);
    setStatus('Sala creada. Escribe tu nombre y entra.');
  }

  async function makeTransport(socket: Socket, device: Device, direction: 'send' | 'recv') {
    const params = await request<any>(socket, 'createWebRtcTransport', { direction });
    const transport = direction === 'send' ? device.createSendTransport(params) : device.createRecvTransport(params);

    transport.on('connect', ({ dtlsParameters }, callback, errback) => {
      request(socket, 'connectTransport', { transportId: transport.id, dtlsParameters })
        .then(() => callback())
        .catch(errback);
    });

    if (direction === 'send') {
      transport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
        request<{ id: string }>(socket, 'produce', { transportId: transport.id, kind, rtpParameters, appData })
          .then(({ id }) => callback({ id }))
          .catch(errback);
      });
    }

    return transport;
  }

  async function consumeProducer(info: ProducerInfo) {
    const socket = socketRef.current;
    const device = deviceRef.current;
    const recvTransport = recvTransportRef.current;
    if (!socket || !device || !recvTransport || consumersRef.current.has(info.producerId)) return;

    const data = await request<any>(socket, 'consume', {
      transportId: recvTransport.id,
      producerId: info.producerId,
      rtpCapabilities: device.rtpCapabilities,
    });

    const consumer = await recvTransport.consume(data);
    consumersRef.current.set(consumer.id, consumer);
    await request(socket, 'resumeConsumer', { consumerId: consumer.id });

    const stream = new MediaStream([consumer.track]);
    setRemoteTracks((tracks) => [
      ...tracks.filter((track) => track.producerId !== info.producerId),
      { id: consumer.id, producerId: info.producerId, username: info.username, kind: consumer.kind as 'audio' | 'video', stream },
    ]);
  }

  async function joinMeeting() {
    if (!roomId.trim()) {
      setStatus('Crea una sala o abre un link /r/:id.');
      return;
    }

    setJoining(true);
    setStatus('Conectando con API y SFU...');

    try {
      const joinResponse = await fetch(`${apiUrl}/meetings/${roomId}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
      const session = await joinResponse.json();
      const socket = io(session.sfuUrl, { transports: ['websocket'] });
      socketRef.current = socket;

      socket.on('newProducer', (producer: ProducerInfo) => void consumeProducer(producer));
      socket.on('producerClosed', ({ producerId }: { producerId: string }) => {
        setRemoteTracks((tracks) => tracks.filter((track) => track.producerId !== producerId));
      });

      const joinData = await request<any>(socket, 'joinRoom', {
        roomId: session.roomId,
        username: session.username,
      });

      const device = new Device();
      await device.load({ routerRtpCapabilities: joinData.routerRtpCapabilities });
      deviceRef.current = device;
      sendTransportRef.current = await makeTransport(socket, device, 'send');
      recvTransportRef.current = await makeTransport(socket, device, 'recv');

      await Promise.all((joinData.existingProducers as ProducerInfo[]).map((producer) => consumeProducer(producer)));
      setJoined(true);
      setStatus('Dentro de la sala. Activa micrófono o comparte pantalla cuando quieras.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'No se pudo unir a la sala.');
    } finally {
      setJoining(false);
    }
  }

  async function toggleMic() {
    if (micEnabled) {
      closeLocalProducer('mic');
      setMicEnabled(false);
      return;
    }

    const transport = sendTransportRef.current;
    if (!transport) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const producer = await transport.produce({ track: stream.getAudioTracks()[0], appData: { source: 'mic' } });
    producersRef.current.set('mic', producer);
    setMicEnabled(true);
  }

  async function toggleScreen() {
    if (screenEnabled) {
      closeLocalProducer('screen');
      setScreenEnabled(false);
      setLocalScreen(null);
      return;
    }

    const transport = sendTransportRef.current;
    const device = deviceRef.current;
    if (!transport) return;
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: 30, max: 60 },
        width: { ideal: 2560 },
        height: { ideal: 1440 },
      },
      audio: false,
    });
    const track = stream.getVideoTracks()[0];
    track.contentHint = 'detail';

    const producer = await transport.produce({
      track,
      codec: device ? selectScreenCodec(device) : undefined,
      encodings: [{ maxBitrate: 8_000_000, maxFramerate: 30, dtx: false }],
      codecOptions: {
        videoGoogleStartBitrate: 2500,
        videoGoogleMinBitrate: 1200,
        videoGoogleMaxBitrate: 8000,
      },
      appData: { source: 'screen', contentHint: 'detail' },
    });

    track.onended = () => {
      closeLocalProducer('screen');
      setScreenEnabled(false);
      setLocalScreen(null);
    };

    producersRef.current.set('screen', producer);
    setLocalScreen(stream);
    setScreenEnabled(true);
  }

  function closeLocalProducer(key: 'mic' | 'screen') {
    const producer = producersRef.current.get(key);
    if (!producer) return;
    socketRef.current?.emit('closeProducer', { producerId: producer.id });
    producer.track?.stop();
    producer.close();
    producersRef.current.delete(key);
  }

  function leaveMeeting() {
    closeLocalProducer('mic');
    closeLocalProducer('screen');
    for (const consumer of consumersRef.current.values()) consumer.close();
    recvTransportRef.current?.close();
    sendTransportRef.current?.close();
    socketRef.current?.disconnect();
    consumersRef.current.clear();
    setRemoteTracks([]);
    setLocalScreen(null);
    setMicEnabled(false);
    setScreenEnabled(false);
    setJoined(false);
    setStatus('Saliste de la sala.');
  }

  useEffect(() => () => leaveMeeting(), []);

  const shareUrl = roomId ? `${window.location.origin}/r/${roomId}` : '';
  const remoteVideos = remoteTracks.filter((track) => track.kind === 'video');
  const remoteAudios = remoteTracks.filter((track) => track.kind === 'audio');

  return (
    <main className="min-h-screen px-4 py-6 md:px-8">
      <section className="mx-auto flex max-w-[90rem] flex-col gap-6">
        <header className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.3em] text-primary">ChatLive WebRTC</p>
            <h1 className="mt-2 text-3xl font-black tracking-tight md:text-5xl">Reuniones web con SFU</h1>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={createMeeting} disabled={joined}>
              <Plus size={18} /> Crear sala
            </Button>
            {shareUrl && (
              <Button variant="secondary" onClick={() => navigator.clipboard.writeText(shareUrl)}>
                <Copy size={18} /> Copiar link
              </Button>
            )}
          </div>
        </header>

        {!joined ? (
          <Card className="mx-auto w-full max-w-xl">
            <div className="mb-5 flex items-center gap-3">
              <div className="rounded-2xl bg-primary/15 p-3 text-primary"><Users /></div>
              <div>
                <h2 className="text-xl font-bold">Entrar a reunión</h2>
                <p className="text-sm text-slate-400">Crea una sala o abre un link compartido.</p>
              </div>
            </div>
            <div className="space-y-3">
              <Input placeholder="Room ID" value={roomId} onChange={(event) => setRoomId(event.target.value)} />
              <Input placeholder="Tu username" value={username} onChange={(event) => setUsername(event.target.value)} />
              <Button className="w-full" onClick={joinMeeting} disabled={joining}>
                {joining ? 'Conectando...' : 'Unirme directamente'}
              </Button>
            </div>
          </Card>
        ) : (
          <>
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[minmax(0,1fr)_360px]">
              <Card className="h-[64vh] min-h-[34rem] p-3 lg:h-[72vh]">
                <div className="grid h-full gap-3 md:grid-cols-2">
                  {localScreen && <VideoTile label={`${username || 'Yo'} compartiendo pantalla`} stream={localScreen} muted />}
                  {remoteVideos.map((track) => <VideoTile key={track.id} label={track.username} stream={track.stream} />)}
                  {!localScreen && remoteVideos.length === 0 && (
                    <div className="flex h-full min-h-[34rem] items-center justify-center rounded-2xl border border-dashed border-border text-center text-slate-400 md:col-span-2">
                      Nadie está compartiendo pantalla todavía.
                    </div>
                  )}
                </div>
              </Card>

              <Card>
                <h2 className="mb-4 text-lg font-bold">Sala</h2>
                <p className="break-all rounded-xl bg-slate-950/60 p-3 text-sm text-slate-300">{shareUrl}</p>
                <p className="mt-4 text-sm text-slate-400">Audio remoto: {remoteAudios.length}</p>
                {remoteAudios.map((track) => <AudioTrack key={track.id} stream={track.stream} />)}
              </Card>
            </div>

            <Card className="sticky bottom-4 mx-auto flex w-fit gap-2 p-3">
              <Button variant={micEnabled ? 'primary' : 'secondary'} onClick={toggleMic}>
                {micEnabled ? <Mic size={18} /> : <MicOff size={18} />} Micrófono
              </Button>
              <Button variant={screenEnabled ? 'primary' : 'secondary'} onClick={toggleScreen}>
                <MonitorUp size={18} /> Pantalla
              </Button>
              <Button variant="danger" onClick={leaveMeeting}>
                <PhoneOff size={18} /> Salir
              </Button>
            </Card>
          </>
        )}

        <p className="text-center text-sm text-slate-400">{status}</p>
      </section>
    </main>
  );
}

function VideoTile({ label, stream, muted = false }: { label: string; stream: MediaStream; muted?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  const tileRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);

  return (
    <div ref={tileRef} className="group relative h-full min-h-[34rem] overflow-hidden rounded-2xl border border-border bg-black">
      <video ref={ref} autoPlay playsInline muted={muted} className="h-full w-full object-cover" />
      <span className="absolute bottom-3 left-3 rounded-full bg-black/70 px-3 py-1 text-xs font-semibold">{label}</span>
      <button
        className="absolute right-3 top-3 inline-flex items-center gap-2 rounded-full bg-black/70 px-3 py-2 text-xs font-semibold opacity-100 transition hover:bg-black/90 md:opacity-0 md:group-hover:opacity-100"
        onClick={() => tileRef.current?.requestFullscreen()}
        type="button"
      >
        <Maximize2 size={14} /> Pantalla completa
      </button>
    </div>
  );
}

function AudioTrack({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);

  return <audio ref={ref} autoPlay playsInline />;
}
