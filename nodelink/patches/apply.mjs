// Text patches for NodeLink sources. Run inside the image at build time.
import fs from 'node:fs';

const patches = [
  {
    // SoundCloud: tracks that only have "cbc-encrypted-hls" fell through to `transcodings[0]`.
    // loadStream then destroys a PassThrough with "Unsupported protocol" and nobody listens for
    // the error, so the whole voice worker crashed and every player on it stopped.
    // Without the fallback the track fails cleanly ("No valid transcoding found") and the bot
    // plays the song from another source.
    file: '/app/src/sources/soundcloud.ts',
    from: '      anyHls ||\n      transcodings[0]\n',
    to: '      anyHls\n',
  },
  {
    // YouTube HLS fallback: when a client's direct URL gives 403, NodeLink switches to the HLS URL.
    // On a flagged IP or account every HLS segment also gives 403; the handler skips each failed
    // segment and plays silence until the bot's 15 s "playerStateChange timed out", so songs were
    // skipped one after another with no reason. Fail the track after 3 failed segments before any
    // audio, so the bot gets an error at once and plays the song from another node or source.
    file: '/app/src/playback/hls/HLSHandler.ts',
    from: "      if (!current) {\n        logger('warn', 'HLSHandler', `Skipping failed segment: ${key}`)\n        continue\n      }\n",
    to: "      if (!current) {\n        logger('warn', 'HLSHandler', `Skipping failed segment: ${key}`)\n        if (!this.isLive && !this.preRolled && ++startFailures >= 3) {\n          this.isFetching = false\n          this.destroy(new Error('HLS segments unavailable (403), no audio received'))\n          return\n        }\n        continue\n      }\n",
  },
  {
    file: '/app/src/playback/hls/HLSHandler.ts',
    from: '  private async _fetchSegments(): Promise<void> {\n    if (this.isFetching || this.stop) return\n',
    to: '  private async _fetchSegments(): Promise<void> {\n    if (this.isFetching || this.stop) return\n    let startFailures = 0\n',
  },
  {
    // Do not cache the HLS fallback URL for 5 hours: when it is broken, every replay of the song on
    // this node reused it. The next play checks the clients again.
    file: '/app/src/sources/youtube/YouTube.ts',
    from: "                additionalData: {\n                  client: clientName,\n                  proxy: proxyToUse\n                }\n              }\n              this.nodelink.trackCacheManager?.set(\n                'youtube',\n                decodedTrack.identifier,\n                result,\n                1000 * 60 * 60 * 5\n              )\n              return result\n",
    to: "                additionalData: {\n                  client: clientName,\n                  proxy: proxyToUse\n                }\n              }\n              return result\n",
  },
  {
    // Voice reconnect circuit breaker: the voice library's 15 s connect timeout closes the socket,
    // which trips the breaker, and the player then resets the connection and removes its 'error'
    // listener. The same timeout callback emits 'error' ("Voice connection timed out") right after,
    // on the old connection with no listener, so it became an uncaught exception, the worker exited
    // and every player on the node stopped (2026-11-02 22:40 and 22:41 UTC, both NodeLinks).
    // Keep a no-op listener on the old connection so late errors from it are dropped.
    file: '/app/src/playback/player.ts',
    from: "      conn.removeListener('error', this._connErrorHandler)\n",
    to: "      conn.removeListener('error', this._connErrorHandler)\n      conn.on('error', () => {})\n",
  },
];

for (const p of patches) {
  const s = fs.readFileSync(p.file, 'utf8');
  if (s.split(p.from).length !== 2) {
    console.error(`patch target not found once in ${p.file}`);
    process.exit(1);
  }
  fs.writeFileSync(p.file, s.replace(p.from, p.to));
  console.log(`patched ${p.file}`);
}
