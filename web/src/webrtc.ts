// WHIP (emitir) y WHEP (ver) sobre WebRTC.
// En local hablan con MediaMTX; con Amazon IVS Real-Time el SDK de IVS cumple el mismo papel.

function waitForIce(pc: RTCPeerConnection, ms = 2500) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => pc.iceGatheringState === 'complete' && done();
    pc.addEventListener('icegatheringstatechange', check);
    setTimeout(done, ms);
  });
}

async function negotiate(pc: RTCPeerConnection, url: string) {
  await pc.setLocalDescription(await pc.createOffer());
  await waitForIce(pc);
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/sdp' }, body: pc.localDescription!.sdp });
  if (res.status === 401 || res.status === 403) throw new Error('El servidor de video rechazó el acceso');
  if (res.status === 404) throw new Error('El directo aún no está emitiendo');
  if (!res.ok) throw new Error(`El servidor de video respondió ${res.status}`);
  await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
}

/**
 * Publica la cámara o la pantalla. El grabador guarda MP4, que admite H.264 y VP9 pero no VP8:
 * se pide H.264 y, si el navegador no lo tiene (Chromium sin códecs propietarios), VP9.
 */
export async function publish(url: string, stream: MediaStream): Promise<RTCPeerConnection> {
  const pc = new RTCPeerConnection();
  for (const track of stream.getTracks()) {
    const t = pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
    if (track.kind === 'video') {
      const codecs = RTCRtpSender.getCapabilities('video')?.codecs ?? [];
      const rank = (mime: string) => ['video/H264', 'video/VP9'].indexOf(mime);
      const recordable = codecs.filter((c) => rank(c.mimeType) >= 0).sort((a, b) => rank(a.mimeType) - rank(b.mimeType));
      if (recordable.length) t.setCodecPreferences([...recordable, ...codecs.filter((c) => rank(c.mimeType) < 0)]);
    }
  }
  try {
    await negotiate(pc, url);
  } catch (e) {
    pc.close();
    throw e;
  }
  return pc;
}

/** Recibe el directo. */
export async function play(url: string, onStream: (s: MediaStream) => void): Promise<RTCPeerConnection> {
  const pc = new RTCPeerConnection();
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('audio', { direction: 'recvonly' });
  pc.ontrack = (e) => onStream(e.streams[0] ?? new MediaStream([e.track]));
  try {
    await negotiate(pc, url);
  } catch (e) {
    pc.close();
    throw e;
  }
  return pc;
}
