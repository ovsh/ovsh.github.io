/*!
 * ambient.js - optional ambient sound beds for the paper-cutout journey.
 *
 * WHAT THIS IS
 *   One quiet, looping ambience per story chapter. Everything is synthesised
 *   live with the Web Audio API: filtered noise, oscillators, LFOs, envelopes
 *   and (for two chapters) a reverb whose impulse response is also generated.
 *   There are NO audio files, NO fetches and NO libraries.
 *
 * HOW TO USE
 *   var amb = createAmbient();               // cheap, creates no AudioContext
 *   button.onclick = function () {           // MUST be a real user gesture
 *     amb.setEnabled(!amb.enabled());        // the AudioContext is born here
 *   };
 *   amb.start('childhood_day');              // pick the opening chapter
 *   amb.setChapter('flight');                // crossfades over ~2 s
 *
 * DESIGN RULES BAKED IN
 *   - Default OFF. The AudioContext is created and resumed only inside the
 *     setEnabled(true) call path, so browser autoplay policy is never fought.
 *   - Silent degradation. No AudioContext, no errors, no console noise.
 *   - CPU light. Noise buffers are generated once and shared by every voice.
 *     Only the chapters that are actually audible exist as nodes; the rest are
 *     torn down after their fade-out. One 250 ms timer drives all sparse
 *     events. The context is suspended when disabled or when the tab hides.
 *   - No clicks. Every loop is a buffer whose tail is crossfaded into its head,
 *     every one-shot starts and ends at zero gain, every chapter change is an
 *     equal-power ramp built from short linear segments (which, unlike
 *     setValueCurveAtTime, can never throw when two fades overlap).
 *
 * TUNING
 *   Each chapter builder below opens with a TUNE block. Those numbers are the
 *   only things you should need to touch. Gains are linear; roughly, halving a
 *   gain is -6 dB. The master gain (MASTER_VOLUME) scales everything.
 */
;(function (global) {
  'use strict';

  /* =======================================================================
   * 1. GLOBAL TUNING
   * ===================================================================== */

  // Master output gain when enabled. The chapter buses are written to peak
  // around 0.55-0.7, so 0.10 here lands the programme peak near -24 dBFS.
  // This is ambience, not a soundtrack: it should sit under the page, not on
  // top of it. Sensible range 0.06 (very shy) .. 0.12 (present).
  var MASTER_VOLUME = 0.10;

  var CROSSFADE_S = 2.0;   // chapter -> chapter crossfade (spec: 1.5-2.5 s)
  var ENABLE_FADE_S = 1.4; // silence -> sound when the user switches it on
  var DISABLE_FADE_S = 0.4;// sound -> silence when the user switches it off
  var SUSPEND_DELAY_MS = 700; // wait for the fade-out before suspending

  var TICK_MS = 250;       // one timer for the whole module
  var LOOKAHEAD_S = 0.7;   // schedule sparse events this far ahead

  // Master tone shaping: keep the top end soft. Ambience that sparkles is
  // ambience you notice, and shrill loops become fatiguing within a minute.
  var MASTER_LP_HZ = 11000; // gentle ceiling
  var MASTER_SHELF_HZ = 5200;
  var MASTER_SHELF_DB = -4.5;
  var MASTER_HP_HZ = 26;    // kill sub rumble and any DC drift

  // Every shared noise buffer is normalised to this RMS, whatever its colour,
  // so a gain of 0.3 means the same loudness whether the layer is white, pink
  // or brown. Change this and every chapter gets louder or quieter together.
  var NOISE_RMS = 0.22;

  /* =======================================================================
   * 2. SMALL UTILITIES
   * ===================================================================== */

  function rnd(a, b) { return a + Math.random() * (b - a); }
  function rndInt(a, b) { return Math.floor(rnd(a, b + 1)); }
  function coin(p) { return Math.random() < p; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function getAudioContextCtor() {
    if (typeof global === 'undefined') return null;
    return global.AudioContext || global.webkitAudioContext || null;
  }

  /**
   * Equal-power ramp on an AudioParam, drawn as N short linear segments.
   *
   * Why not setValueCurveAtTime: it throws NotSupportedError when a new curve
   * overlaps a running one, which is exactly what happens if the reader
   * scrolls through three chapters in two seconds. Linear ramps compose with
   * cancelScheduledValues without complaint. 24 segments over 2 s is a
   * 12 Hz approximation of a cosine - inaudible.
   *
   * Fading in follows sin(u*pi/2), fading out follows cos(u*pi/2), so during a
   * crossfade the two gains satisfy sin^2 + cos^2 = 1: constant power, no dip
   * in the middle and no bump.
   */
  var RAMP_SEGMENTS = 24;
  function equalPowerRamp(param, now, dur, target, fadingIn) {
    var v0 = paramValue(param);
    var i, u, g;
    try { param.cancelScheduledValues(now); } catch (e) {}
    param.setValueAtTime(v0, now);
    if (fadingIn) {
      // Resume the sine curve from wherever the value currently sits, so an
      // interrupted fade-in continues smoothly instead of jumping.
      var ratio = target > 1e-6 ? clamp(v0 / target, 0, 1) : 0;
      var u0 = Math.asin(ratio) / (Math.PI / 2);
      for (i = 1; i <= RAMP_SEGMENTS; i++) {
        u = u0 + (1 - u0) * (i / RAMP_SEGMENTS);
        g = target * Math.sin(u * (Math.PI / 2));
        param.linearRampToValueAtTime(g, now + dur * (i / RAMP_SEGMENTS));
      }
      param.linearRampToValueAtTime(target, now + dur);
    } else {
      for (i = 1; i <= RAMP_SEGMENTS; i++) {
        u = i / RAMP_SEGMENTS;
        g = v0 * Math.cos(u * (Math.PI / 2));
        param.linearRampToValueAtTime(g < 0 ? 0 : g, now + dur * u);
      }
      param.linearRampToValueAtTime(0, now + dur);
    }
  }

  function paramValue(param) {
    var v = param.value;
    return (typeof v === 'number' && isFinite(v)) ? v : 0;
  }

  /**
   * One-shot amplitude envelope: linear attack from true zero (no click),
   * exponential decay (natural), then pinned to zero so nothing lingers.
   * Returns the time at which the voice is finished.
   */
  function env(param, t, peak, attack, decay, hold) {
    hold = hold || 0;
    var floor = 0.0001;
    var top = peak > floor * 2 ? peak : floor * 2;
    try { param.cancelScheduledValues(t); } catch (e) {}
    param.setValueAtTime(0, t);
    param.linearRampToValueAtTime(top, t + attack);
    if (hold > 0) param.setValueAtTime(top, t + attack + hold);
    param.exponentialRampToValueAtTime(floor, t + attack + hold + decay);
    param.setValueAtTime(0, t + attack + hold + decay + 0.004);
    return t + attack + hold + decay + 0.02;
  }

  /* =======================================================================
   * 3. GENERATED BUFFERS  (all shared, all seamless)
   * ===================================================================== */

  /**
   * Noise buffer with a seamless loop point.
   *
   * The generator runs for (len + xfade) samples; the extra tail is then
   * crossfaded (equal power, because the two halves are uncorrelated) into the
   * head. At the loop seam sample len-1 is followed by a sample that is almost
   * exactly the sample that originally followed it, so there is no step and no
   * click - which matters most for brown noise, where a step is a thump.
   *
   * kind: 'white' | 'pink' | 'brown'
   */
  function makeNoiseBuffer(ctx, seconds, kind) {
    var sr = ctx.sampleRate;
    var len = Math.floor(sr * seconds);
    var xf = Math.floor(sr * 0.05); // 50 ms seam
    var n = len + xf;
    var raw = new Float32Array(n);
    var i, w;

    if (kind === 'pink') {
      // Paul Kellet's economical pink filter: -3 dB/octave, cheap and stable.
      var b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (i = 0; i < n; i++) {
        w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.96900 * b2 + w * 0.1538520;
        b3 = 0.86650 * b3 + w * 0.3104856;
        b4 = 0.55000 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.0168980;
        raw[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
        b6 = w * 0.115926;
      }
    } else if (kind === 'brown') {
      // Leaky integrator (-6 dB/octave) plus a one-pole DC blocker, so the
      // wander cannot drift the whole buffer off centre.
      var acc = 0, dcX = 0, dcY = 0;
      var R = 1 - (8 * Math.PI / sr); // ~8 Hz high pass
      for (i = 0; i < n; i++) {
        w = Math.random() * 2 - 1;
        acc = (acc + 0.02 * w) / 1.02;
        dcY = acc - dcX + R * dcY;
        dcX = acc;
        raw[i] = dcY;
      }
    } else {
      for (i = 0; i < n; i++) raw[i] = Math.random() * 2 - 1;
    }

    // Normalise by RMS, not by peak. White noise has a crest factor of about
    // 1.7 and pink/brown about 4, so peak-normalising would deliver white 7 dB
    // hotter than the others and every layer gain would mean something
    // different depending on which buffer it used. Matching RMS makes the
    // gain numbers in the chapters directly comparable across kinds.
    var sum2 = 0;
    for (i = 0; i < n; i++) sum2 += raw[i] * raw[i];
    var rms = Math.sqrt(sum2 / n);
    var scale = rms > 1e-9 ? NOISE_RMS / rms : 0;
    // Guard against a stray peak overflowing after the seam crossfade, which
    // can add up to 3 dB where the two halves happen to agree.
    var peak = 0;
    for (i = 0; i < n; i++) { var a = raw[i] < 0 ? -raw[i] : raw[i]; if (a > peak) peak = a; }
    if (peak * scale > 0.99) scale = 0.99 / peak;
    for (i = 0; i < n; i++) raw[i] *= scale;

    var buf = ctx.createBuffer(1, len, sr);
    var d = buf.getChannelData(0);
    for (i = 0; i < len; i++) d[i] = raw[i];
    for (i = 0; i < xf; i++) {
      var u = i / xf;
      d[i] = raw[i] * Math.sin(u * (Math.PI / 2)) + raw[len + i] * Math.cos(u * (Math.PI / 2));
    }
    return buf;
  }

  /**
   * Slow organic modulation curve in [0,1], seamless by construction: it is a
   * sum of sinusoids whose periods all divide the buffer length exactly, with
   * random phases. One looping BufferSource wired into an AudioParam replaces
   * a stack of LFO oscillators, and never sounds as obviously periodic.
   */
  function makeSmoothModBuffer(ctx, seconds, harmonics, shape) {
    var sr = ctx.sampleRate;
    var len = Math.floor(sr * seconds);
    var buf = ctx.createBuffer(1, len, sr);
    var d = buf.getChannelData(0);
    var ks = harmonics || [1, 2, 3, 5, 7];
    var amps = [], phases = [], i, k, total = 0;
    for (k = 0; k < ks.length; k++) {
      amps.push(1 / (k + 1) * rnd(0.7, 1.3));
      phases.push(Math.random() * Math.PI * 2);
      total += amps[k];
    }
    var min = 1e9, max = -1e9;
    for (i = 0; i < len; i++) {
      var v = 0, t = i / len;
      for (k = 0; k < ks.length; k++) v += amps[k] * Math.sin(2 * Math.PI * ks[k] * t + phases[k]);
      v /= total;
      d[i] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    var span = (max - min) || 1;
    for (i = 0; i < len; i++) {
      var u = (d[i] - min) / span;              // -> [0,1]
      d[i] = shape && shape !== 1 ? Math.pow(u, shape) : u;
    }
    return buf;
  }

  /**
   * Cricket gate: a chirp of `pulses` short raised-cosine pulses, repeated
   * every `period` seconds with a little jitter so it never sounds like a
   * metronome. Values in [0,1], starts and ends at 0, so it loops silently.
   */
  function makeCricketBuffer(ctx, seconds, period, pulses) {
    var sr = ctx.sampleRate;
    var len = Math.floor(sr * seconds);
    var buf = ctx.createBuffer(1, len, sr);
    var d = buf.getChannelData(0);
    var pulseLen = 0.014, pulseGap = 0.024;
    var t = 0.1;
    while (t < seconds - 0.4) {
      var count = pulses + (coin(0.25) ? 1 : 0);
      var amp = rnd(0.75, 1.0);
      for (var p = 0; p < count; p++) {
        var s0 = Math.floor((t + p * (pulseLen + pulseGap)) * sr);
        var n = Math.floor(pulseLen * sr);
        for (var i = 0; i < n; i++) {
          var idx = s0 + i;
          if (idx >= 0 && idx < len) {
            d[idx] = amp * 0.5 * (1 - Math.cos(2 * Math.PI * i / n));
          }
        }
      }
      t += period * rnd(0.86, 1.16);
    }
    return buf;
  }

  /**
   * Projector gate: a sharp bump per film frame over a continuous floor, so
   * the whir has a rhythm without gating fully to silence. `hz` is the frame
   * rate (24 for film). Buffer length is a whole number of seconds and hz is
   * an integer, so the loop is sample-exact.
   */
  function makeProjectorBuffer(ctx, seconds, hz, floor) {
    var sr = ctx.sampleRate;
    var len = Math.floor(sr * Math.round(seconds));
    var buf = ctx.createBuffer(1, len, sr);
    var d = buf.getChannelData(0);
    var period = sr / hz;
    var attack = sr * 0.0022, decay = sr * 0.013;
    for (var i = 0; i < len; i++) {
      var ph = i % period;
      var v;
      if (ph < attack) v = ph / attack;
      else v = Math.exp(-(ph - attack) / decay);
      d[i] = floor + (1 - floor) * v;
    }
    return buf;
  }

  /**
   * Babble gate: syllables (raised-cosine bumps of speech-like length) grouped
   * into phrases with pauses between them. Drives both the voiced talkers and
   * the crowd wash. Values in [0,1], ends at 0.
   */
  function makeBabbleBuffer(ctx, seconds) {
    var sr = ctx.sampleRate;
    var len = Math.floor(sr * seconds);
    var buf = ctx.createBuffer(1, len, sr);
    var d = buf.getChannelData(0);
    var t = rnd(0.2, 0.8);
    while (t < seconds - 0.5) {
      var syllables = rndInt(4, 11);   // one phrase
      for (var s = 0; s < syllables && t < seconds - 0.3; s++) {
        var dur = rnd(0.09, 0.22);
        var amp = rnd(0.35, 1.0);
        var s0 = Math.floor(t * sr), n = Math.floor(dur * sr);
        for (var i = 0; i < n; i++) {
          var idx = s0 + i;
          if (idx >= 0 && idx < len) d[idx] = amp * 0.5 * (1 - Math.cos(2 * Math.PI * i / n));
        }
        t += dur + rnd(0.02, 0.1);
      }
      t += rnd(0.5, 2.4); // breath between phrases
    }
    return buf;
  }

  /**
   * Reverb impulse: decaying stereo noise, one-pole low passed so the tail is
   * warm rather than hissy, with a short pre-delay for a sense of size.
   * ConvolverNode has no feedback path, so there is no denormal risk here.
   */
  function makeImpulse(ctx, seconds, decayPow, tone) {
    var sr = ctx.sampleRate;
    var len = Math.floor(sr * seconds);
    var pre = Math.floor(sr * 0.012);
    var buf = ctx.createBuffer(2, len, sr);
    var a = tone == null ? 0.35 : tone; // lower = darker tail
    for (var ch = 0; ch < 2; ch++) {
      var d = buf.getChannelData(ch);
      var y = 0;
      for (var i = 0; i < len; i++) {
        if (i < pre) { d[i] = 0; continue; }
        var x = (Math.random() * 2 - 1) * Math.pow(1 - (i - pre) / (len - pre), decayPow);
        y = y + a * (x - y);
        d[i] = y;
      }
    }
    return buf;
  }

  /* =======================================================================
   * 4. RIG - a chapter's node graph, its event streams and its teardown
   * ===================================================================== */

  function Rig(ctx, dest, lib) {
    this.ctx = ctx;
    this.lib = lib;
    this.out = ctx.createGain();
    this.out.gain.value = 0;      // always fade in from silence
    this.out.connect(dest);
    this.nodes = [this.out];
    this.streams = [];
    this.live = [];               // one-shot voices still sounding
    this.dead = false;
  }

  Rig.prototype.mk = function (kind) {
    var n;
    if (kind === 'gain') n = this.ctx.createGain();
    else if (kind === 'biquad') n = this.ctx.createBiquadFilter();
    else if (kind === 'osc') n = this.ctx.createOscillator();
    else if (kind === 'buf') n = this.ctx.createBufferSource();
    else if (kind === 'conv') n = this.ctx.createConvolver();
    else if (kind === 'pan') n = this.ctx.createStereoPanner();
    else return null;
    this.nodes.push(n);
    return n;
  };

  /** Looping source over one of the shared noise buffers. */
  Rig.prototype.noise = function (kind, rate) {
    var src = this.mk('buf');
    var buf = this.lib.noise(kind);
    src.buffer = buf;
    src.loop = true;
    // Slight rate offsets decorrelate simultaneous sources and stagger the
    // effective loop lengths, so nothing lines up into an audible cycle.
    src.playbackRate.value = rate || 1;
    src.start(this.ctx.currentTime, Math.random() * buf.duration);
    return src;
  };

  /** Panner, or a plain gain on browsers without StereoPannerNode. */
  Rig.prototype.panner = function (p) {
    if (!this.ctx.createStereoPanner) return this.mk('gain');
    var n = this.mk('pan');
    n.pan.value = clamp(p, -1, 1);
    return n;
  };

  Rig.prototype.filter = function (type, freq, q) {
    var f = this.mk('biquad');
    f.type = type;
    f.frequency.value = freq;
    if (q != null) f.Q.value = q;
    return f;
  };

  /**
   * A filtered-noise layer, the workhorse of every chapter.
   *   kind, rate            which shared noise buffer and at what speed
   *   hp                    high pass (Hz)
   *   bp:[freq,Q]           band pass
   *   lp, lpPoles           low pass (Hz), 1 or 2 cascaded poles (-12/-24 dB)
   *   gain                  layer level
   *   pan                   -1..1
   *   to                    destination node (default: the chapter bus)
   * Returns the parts you may want to modulate.
   */
  Rig.prototype.layer = function (o) {
    var src = this.noise(o.kind || 'pink', o.rate);
    var node = src, hp = null, bp = null, lp = null, lp2 = null, f;
    if (o.hp) { hp = this.filter('highpass', o.hp, o.hpQ || 0.7); node.connect(hp); node = hp; }
    if (o.bp) { bp = this.filter('bandpass', o.bp[0], o.bp[1]); node.connect(bp); node = bp; }
    if (o.lp) {
      lp = this.filter('lowpass', o.lp, o.lpQ || 0.7);
      node.connect(lp); node = lp;
      if (o.lpPoles === 2) { lp2 = this.filter('lowpass', o.lp, 0.7); node.connect(lp2); node = lp2; }
    }
    var g = this.mk('gain');
    g.gain.value = o.gain == null ? 0.1 : o.gain;
    node.connect(g); node = g;
    if (o.pan != null) { var p = this.panner(o.pan); g.connect(p); node = p; }
    node.connect(o.to || this.out);
    return { src: src, hp: hp, bp: bp, lp: lp, lp2: lp2, gain: g, out: node };
  };

  /**
   * Drive an AudioParam from a looping control buffer.
   * The buffer holds 0..1; the param rests at `base` and the buffer adds up to
   * `depth` on top, so base=0.2, depth=0.6 sweeps 0.2 .. 0.8.
   */
  Rig.prototype.mod = function (buf, param, base, depth, rate) {
    var src = this.mk('buf');
    src.buffer = buf;
    src.loop = true;
    src.playbackRate.value = rate || 1;
    var g = this.mk('gain');
    g.gain.value = depth;
    src.connect(g);
    g.connect(param);
    param.value = base;
    src.start(this.ctx.currentTime, Math.random() * buf.duration);
    return { src: src, depth: g };
  };

  /** Classic oscillator LFO, for motion that should be smooth and regular. */
  Rig.prototype.lfo = function (hz, base, depth, param) {
    var o = this.mk('osc');
    o.type = 'sine';
    o.frequency.value = hz;
    var g = this.mk('gain');
    g.gain.value = depth;
    o.connect(g);
    g.connect(param);
    param.value = base;
    o.start(this.ctx.currentTime + Math.random() * 0.01);
    return o;
  };

  /** A steady sine partial - motor hum, mains hum, engine tone. */
  Rig.prototype.tone = function (hz, gain, pan, to) {
    var o = this.mk('osc');
    o.type = 'sine';
    o.frequency.value = hz;
    var g = this.mk('gain');
    g.gain.value = 0;
    o.connect(g);
    var node = g;
    if (pan != null) { var p = this.panner(pan); g.connect(p); node = p; }
    node.connect(to || this.out);
    var now = this.ctx.currentTime;
    // Fade the tone in over 1.5 s: starting a sine at full gain is a click.
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(gain, now + 1.5);
    o.start(now);
    return { osc: o, gain: g };
  };

  /**
   * Register a sparse event stream. `fn(time)` is called with the exact
   * AudioContext time at which the event should sound, always in the future.
   */
  Rig.prototype.every = function (minS, maxS, fn) {
    this.streams.push({
      next: this.ctx.currentTime + rnd(0.6, Math.max(1.2, minS)),
      min: minS, max: maxS, fn: fn
    });
  };

  /** Book-keeping for a one-shot voice so dispose() can silence it. */
  Rig.prototype.oneshot = function (head, tail, stopTime) {
    if (this.dead) { try { head.stop(0); } catch (e) {} return; }
    var self = this;
    var entry = { head: head, tail: tail };
    this.live.push(entry);
    head.onended = function () {
      try { head.disconnect(); } catch (e) {}
      try { tail.disconnect(); } catch (e) {}
      var i = self.live.indexOf(entry);
      if (i >= 0) self.live.splice(i, 1);
    };
    try { head.stop(stopTime); } catch (e) {}
  };

  Rig.prototype.tick = function (now) {
    var horizon = now + LOOKAHEAD_S;
    for (var i = 0; i < this.streams.length; i++) {
      var s = this.streams[i];
      // If time has run on without us - the sound was switched off, the tab
      // was hidden, the timer was throttled - the stream is now in the past.
      // Skip it forward. Catching up event by event would fire a whole
      // minute's worth of birds in the same tenth of a second.
      if (s.next < now) s.next = now + rnd(0.1, s.max);
      var guard = 0;
      while (s.next < horizon && guard++ < 12) {
        try { s.fn(s.next); } catch (e) {}
        s.next += rnd(s.min, s.max);
      }
    }
  };

  Rig.prototype.dispose = function () {
    this.dead = true;
    this.streams.length = 0;
    var i;
    for (i = 0; i < this.live.length; i++) {
      try { this.live[i].head.onended = null; } catch (e) {}
      try { this.live[i].head.stop(0); } catch (e) {}
      try { this.live[i].head.disconnect(); } catch (e) {}
      try { this.live[i].tail.disconnect(); } catch (e) {}
    }
    this.live.length = 0;
    for (i = this.nodes.length - 1; i >= 0; i--) {
      var n = this.nodes[i];
      if (n.stop) { try { n.stop(0); } catch (e) {} }
      try { n.disconnect(); } catch (e) {}
    }
    this.nodes.length = 0;
  };

  /* =======================================================================
   * 5. SHARED ONE-SHOT VOICES
   * ===================================================================== */

  /**
   * Bird call. A sine glide is a surprisingly good small bird: the ear reads
   * the pitch contour, not the timbre. `f0` is the start pitch; the glide goes
   * up to f0*rise then falls back. Kept under ~3.6 kHz so it never gets shrill.
   */
  function birdChirp(rig, t, o) {
    var dur = o.dur || rnd(0.05, 0.085);
    var osc = rig.ctx.createOscillator();
    osc.type = 'sine';
    var f0 = o.f0, f1 = f0 * (o.rise || rnd(1.25, 1.5));
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(f1, t + dur * 0.5);
    osc.frequency.exponentialRampToValueAtTime(f0 * (o.fall || 0.9), t + dur);
    var g = rig.ctx.createGain();
    g.gain.value = 0;
    var lp = rig.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 5000;
    var p = rig.ctx.createStereoPanner ? rig.ctx.createStereoPanner() : rig.ctx.createGain();
    if (p.pan) p.pan.value = clamp(o.pan == null ? rnd(-0.6, 0.6) : o.pan, -1, 1);
    osc.connect(g); g.connect(lp); lp.connect(p); p.connect(o.to || rig.out);
    var end = env(g.gain, t, o.gain == null ? 0.05 : o.gain, 0.008, dur, 0);
    osc.start(t);
    rig.oneshot(osc, p, end);
    return end;
  }

  /** A phrase of 2-5 chirps: how birds actually punctuate a garden. */
  function birdPhrase(rig, t, o) {
    var n = rndInt(o.min || 2, o.max || 4);
    var f0 = rnd(o.lo || 2100, o.hi || 3200);
    var pan = rnd(-0.7, 0.7);
    for (var i = 0; i < n; i++) {
      birdChirp(rig, t + i * rnd(0.055, 0.12), {
        f0: f0 * rnd(0.94, 1.06),
        gain: (o.gain == null ? 0.05 : o.gain) * rnd(0.7, 1),
        pan: pan + rnd(-0.08, 0.08),
        to: o.to
      });
    }
  }

  /** Slow two-note whistle - a different species, for variety in the meadow. */
  function birdWhistle(rig, t, o) {
    var osc = rig.ctx.createOscillator();
    osc.type = 'sine';
    var f = rnd(1250, 1650);
    osc.frequency.setValueAtTime(f, t);
    osc.frequency.exponentialRampToValueAtTime(f * 0.82, t + 0.19);
    osc.frequency.setValueAtTime(f * 0.82, t + 0.30);
    osc.frequency.exponentialRampToValueAtTime(f * 0.70, t + 0.46);
    var g = rig.ctx.createGain(); g.gain.value = 0;
    var p = rig.ctx.createStereoPanner ? rig.ctx.createStereoPanner() : rig.ctx.createGain();
    if (p.pan) p.pan.value = rnd(-0.8, 0.8);
    osc.connect(g); g.connect(p); p.connect(o.to || rig.out);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(o.gain || 0.035, t + 0.03);
    g.gain.setValueAtTime(o.gain || 0.035, t + 0.17);
    g.gain.linearRampToValueAtTime(0.0008, t + 0.22);
    g.gain.linearRampToValueAtTime(o.gain || 0.035, t + 0.32);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    g.gain.setValueAtTime(0, t + 0.51);
    osc.start(t);
    rig.oneshot(osc, p, t + 0.55);
  }

  /**
   * Keyboard key. Two parts, because that is what a real key is: the plastic
   * click (band passed noise, milliseconds long) and the dull thock of the
   * key bottoming out (a low sine blip).
   */
  function keyTick(rig, t, o) {
    var gainScale = o.gain == null ? 1 : o.gain;
    var pan = o.pan == null ? rnd(-0.3, 0.3) : o.pan;

    var src = rig.ctx.createBufferSource();
    src.buffer = rig.lib.noise('white');
    src.loop = true;
    src.playbackRate.value = rnd(0.9, 1.1);
    var bp = rig.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = rnd(o.lo || 1500, o.hi || 2900);
    bp.Q.value = 1.1;
    var g = rig.ctx.createGain(); g.gain.value = 0;
    var p = rig.ctx.createStereoPanner ? rig.ctx.createStereoPanner() : rig.ctx.createGain();
    if (p.pan) p.pan.value = pan;
    src.connect(bp); bp.connect(g); g.connect(p); p.connect(o.to || rig.out);
    var end = env(g.gain, t, 0.13 * gainScale * rnd(0.7, 1.15), 0.001, rnd(0.014, 0.026));
    src.start(t, Math.random() * 1.0);
    rig.oneshot(src, p, end);

    // the thock
    var osc = rig.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(rnd(190, 260), t);
    osc.frequency.exponentialRampToValueAtTime(rnd(120, 160), t + 0.05);
    var g2 = rig.ctx.createGain(); g2.gain.value = 0;
    var p2 = rig.ctx.createStereoPanner ? rig.ctx.createStereoPanner() : rig.ctx.createGain();
    if (p2.pan) p2.pan.value = pan;
    osc.connect(g2); g2.connect(p2); p2.connect(o.to || rig.out);
    var end2 = env(g2.gain, t, 0.022 * gainScale, 0.002, 0.045);
    osc.start(t);
    rig.oneshot(osc, p2, end2);
  }

  /** A run of typing: people type in bursts, then stop and think. */
  function typingBurst(rig, t, o) {
    var n = rndInt(o.min || 3, o.max || 8);
    var tt = t;
    for (var i = 0; i < n; i++) {
      keyTick(rig, tt, o);
      tt += rnd(0.07, 0.16);
      if (coin(0.12)) tt += rnd(0.2, 0.5); // a pause mid-word
    }
  }

  /** Mouse click: duller and lower than a key, and always a pair. */
  function mouseClick(rig, t, o) {
    keyTick(rig, t, { gain: 0.8, lo: 900, hi: 1500, pan: o.pan == null ? 0.25 : o.pan, to: o.to });
    keyTick(rig, t + rnd(0.055, 0.085), { gain: 0.6, lo: 900, hi: 1500, pan: o.pan == null ? 0.25 : o.pan, to: o.to });
  }

  /**
   * Short bright click - film sprocket, reel splice, a switch.
   */
  function click(rig, t, o) {
    var src = rig.ctx.createBufferSource();
    src.buffer = rig.lib.noise('white');
    src.loop = true;
    var bp = rig.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = o.freq || 2400;
    bp.Q.value = o.q || 2.5;
    var g = rig.ctx.createGain(); g.gain.value = 0;
    var p = rig.ctx.createStereoPanner ? rig.ctx.createStereoPanner() : rig.ctx.createGain();
    if (p.pan) p.pan.value = o.pan == null ? 0 : o.pan;
    src.connect(bp); bp.connect(g); g.connect(p);
    p.connect(o.to || rig.out);
    if (o.send) p.connect(o.send);
    var end = env(g.gain, t, o.gain == null ? 0.115 : o.gain, 0.0015, o.decay || 0.02);
    src.start(t, Math.random() * 1.0);
    rig.oneshot(src, p, end);
  }

  /**
   * Paper: a noise burst whose band pass sweeps upward while the amplitude
   * makes two bumps - the grab and the release. Reads as a page turn.
   */
  function pageTurn(rig, t, o) {
    var dur = rnd(0.26, 0.40);
    var src = rig.ctx.createBufferSource();
    src.buffer = rig.lib.noise('white');
    src.loop = true;
    src.playbackRate.value = rnd(0.9, 1.1);
    var bp = rig.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.0;
    bp.frequency.setValueAtTime(1200, t);
    bp.frequency.exponentialRampToValueAtTime(3600, t + dur * 0.55);
    bp.frequency.exponentialRampToValueAtTime(1900, t + dur);
    var lp = rig.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 5200;
    var g = rig.ctx.createGain(); g.gain.value = 0;
    var p = rig.ctx.createStereoPanner ? rig.ctx.createStereoPanner() : rig.ctx.createGain();
    if (p.pan) p.pan.value = o.pan == null ? rnd(-0.4, 0.4) : o.pan;
    src.connect(bp); bp.connect(lp); lp.connect(g); g.connect(p); p.connect(o.to || rig.out);
    var pk = o.gain == null ? 0.115 : o.gain;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(pk, t + 0.03);
    g.gain.linearRampToValueAtTime(pk * 0.35, t + dur * 0.45);
    g.gain.linearRampToValueAtTime(pk * 0.8, t + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.gain.setValueAtTime(0, t + dur + 0.005);
    src.start(t, Math.random() * 1.0);
    rig.oneshot(src, p, t + dur + 0.03);
  }

  /**
   * Vehicle passing by: band passed noise that swells, brightens and pans
   * across the stereo field. This single gesture does more to say "street"
   * than any amount of static traffic noise.
   */
  function passBy(rig, t, o) {
    var dur = o.dur || rnd(3.2, 4.8);
    var dir = coin(0.5) ? 1 : -1;
    var src = rig.ctx.createBufferSource();
    src.buffer = rig.lib.noise('pink');
    src.loop = true;
    src.playbackRate.value = rnd(0.85, 1.15);
    var bp = rig.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 0.55;
    bp.frequency.setValueAtTime(o.lo || 240, t);
    bp.frequency.linearRampToValueAtTime(o.hi || 900, t + dur * 0.5);
    bp.frequency.linearRampToValueAtTime(o.lo || 240, t + dur);
    var lp = rig.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = o.top || 2400;
    var g = rig.ctx.createGain(); g.gain.value = 0;
    var p = rig.ctx.createStereoPanner ? rig.ctx.createStereoPanner() : rig.ctx.createGain();
    if (p.pan) {
      p.pan.setValueAtTime(-0.85 * dir, t);
      p.pan.linearRampToValueAtTime(0.85 * dir, t + dur);
    }
    src.connect(bp); bp.connect(lp); lp.connect(g); g.connect(p); p.connect(o.to || rig.out);
    var pk = o.gain == null ? 0.2 : o.gain;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(pk, t + dur * 0.5);
    g.gain.linearRampToValueAtTime(0, t + dur);
    src.start(t, Math.random() * 2.0);
    rig.oneshot(src, p, t + dur + 0.05);
  }

  /**
   * Distant car horn: two detuned saws through a low pass, which is what
   * distance does to a horn - the top is gone, the beating is not.
   */
  function carHorn(rig, t, o) {
    var f = rnd(310, 420);
    var dur = rnd(0.25, 0.65);
    var oscA = rig.ctx.createOscillator(); oscA.type = 'sawtooth'; oscA.frequency.value = f;
    var oscB = rig.ctx.createOscillator(); oscB.type = 'sawtooth'; oscB.frequency.value = f * rnd(1.18, 1.26);
    var hp = rig.ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 220;
    var lp = rig.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = o.top || 1300; lp.Q.value = 0.6;
    var g = rig.ctx.createGain(); g.gain.value = 0;
    var p = rig.ctx.createStereoPanner ? rig.ctx.createStereoPanner() : rig.ctx.createGain();
    if (p.pan) p.pan.value = rnd(-0.7, 0.7);
    oscA.connect(hp); oscB.connect(hp); hp.connect(lp); lp.connect(g); g.connect(p);
    p.connect(o.to || rig.out);
    var end = env(g.gain, t, o.gain == null ? 0.045 : o.gain, 0.035, 0.18, dur);
    oscA.start(t); oscB.start(t);
    rig.oneshot(oscA, p, end);
    rig.oneshot(oscB, g, end);
    var depth = o.depth || 0;
    if (depth < 2 && coin(0.35)) { // double honk, never a whole fanfare
      carHorn(rig, end + rnd(0.05, 0.2), {
        gain: (o.gain == null ? 0.045 : o.gain) * 0.85, top: o.top, to: o.to, depth: depth + 1
      });
    }
  }

  /**
   * Cabin chime. Two inharmonic partials (2.76 is a classic bell ratio) with a
   * long exponential tail, optionally answered a fourth below.
   */
  function chime(rig, t, o) {
    var f = o.freq || 1046.5;
    var a = rig.ctx.createOscillator(); a.type = 'sine'; a.frequency.value = f;
    var b = rig.ctx.createOscillator(); b.type = 'sine'; b.frequency.value = f * 2.76;
    var gb = rig.ctx.createGain(); gb.gain.value = 0.16; // the partial stays discreet
    var g = rig.ctx.createGain(); g.gain.value = 0;
    var lp = rig.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 4200;
    var p = rig.ctx.createStereoPanner ? rig.ctx.createStereoPanner() : rig.ctx.createGain();
    if (p.pan) p.pan.value = o.pan == null ? rnd(-0.4, 0.4) : o.pan;
    a.connect(g); b.connect(gb); gb.connect(g); g.connect(lp); lp.connect(p);
    p.connect(o.to || rig.out);
    if (o.send) p.connect(o.send);
    var end = env(g.gain, t, o.gain == null ? 0.05 : o.gain, 0.006, o.decay || 1.3);
    a.start(t); b.start(t);
    rig.oneshot(a, p, end);
    rig.oneshot(b, gb, end);
    if (o.two) chime(rig, t + 0.42, { freq: f * 0.749, gain: (o.gain || 0.05) * 0.85, decay: 1.5, send: o.send, to: o.to });
  }

  /**
   * Wooden creak: a resonant band sweeping down, amplitude stuttered so it
   * groans rather than glides. Used sparingly in the empty theatre.
   */
  function creak(rig, t, o) {
    var dur = rnd(0.35, 0.7);
    var src = rig.ctx.createBufferSource();
    src.buffer = rig.lib.noise('white');
    src.loop = true;
    var bp = rig.ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = 14;
    var f0 = rnd(150, 260);
    bp.frequency.setValueAtTime(f0, t);
    bp.frequency.exponentialRampToValueAtTime(f0 * rnd(0.55, 0.75), t + dur);
    var g = rig.ctx.createGain(); g.gain.value = 0;
    var p = rig.ctx.createStereoPanner ? rig.ctx.createStereoPanner() : rig.ctx.createGain();
    if (p.pan) p.pan.value = rnd(-0.7, 0.7);
    src.connect(bp); bp.connect(g); g.connect(p); p.connect(o.to || rig.out);
    if (o.send) p.connect(o.send);
    var pk = o.gain == null ? 0.11 : o.gain;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(pk, t + 0.06);
    g.gain.linearRampToValueAtTime(pk * 0.45, t + dur * 0.4);
    g.gain.linearRampToValueAtTime(pk * 0.8, t + dur * 0.65);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.gain.setValueAtTime(0, t + dur + 0.005);
    src.start(t, Math.random() * 1.0);
    rig.oneshot(src, p, t + dur + 0.03);
  }

  /** Rain drip - a soft resonant plink for the optional rain layer. */
  function drip(rig, t, o) {
    var osc = rig.ctx.createOscillator();
    osc.type = 'sine';
    var f = rnd(700, 1500);
    osc.frequency.setValueAtTime(f, t);
    osc.frequency.exponentialRampToValueAtTime(f * 1.5, t + 0.05);
    var g = rig.ctx.createGain(); g.gain.value = 0;
    var p = rig.ctx.createStereoPanner ? rig.ctx.createStereoPanner() : rig.ctx.createGain();
    if (p.pan) p.pan.value = rnd(-0.6, 0.6);
    osc.connect(g); g.connect(p); p.connect(o.to || rig.out);
    var end = env(g.gain, t, o.gain == null ? 0.02 : o.gain, 0.003, 0.07);
    osc.start(t);
    rig.oneshot(osc, p, end);
  }

  /**
   * A talker. Not words - the impression of words: a drifting sawtooth
   * (the voice), noise (the breath), both squeezed through two formant band
   * passes and gated by the shared syllable envelope. Low passed hard, because
   * conversation you can make out is conversation you start listening to.
   *
   *   pitch  ~115 lower voice, ~190 higher voice
   *   f1/f2  formant pair; 500/1500 is a neutral vowel
   */
  function talker(rig, o) {
    var voice = rig.mk('osc');
    voice.type = 'sawtooth';
    voice.frequency.value = o.pitch;
    // Pitch drift over a few seconds keeps it from sounding like a drone.
    rig.mod(rig.lib.mod('drift'), voice.frequency, o.pitch * 0.94, o.pitch * 0.14, rnd(0.7, 1.2));
    voice.start(rig.ctx.currentTime);

    var breath = rig.noise('white', rnd(0.9, 1.1));
    var breathG = rig.mk('gain'); breathG.gain.value = 0.28;
    breath.connect(breathG);

    var hp = rig.filter('highpass', o.pitch * 1.2, 0.7);
    voice.connect(hp); breathG.connect(hp);

    var f1 = rig.filter('bandpass', o.f1 || 520, 5);
    var f2 = rig.filter('bandpass', o.f2 || 1500, 7);
    hp.connect(f1); hp.connect(f2);
    var f2g = rig.mk('gain'); f2g.gain.value = 0.6;
    f2.connect(f2g);

    var syl = rig.mk('gain'); syl.gain.value = 0;
    f1.connect(syl); f2g.connect(syl);
    rig.mod(rig.lib.mod('babble'), syl.gain, 0, 1, o.rate || rnd(0.85, 1.15));

    var lp = rig.filter('lowpass', o.lp || 1900, 0.7);
    var lp2 = rig.filter('lowpass', o.lp || 1900, 0.7);
    var g = rig.mk('gain'); g.gain.value = o.gain;
    syl.connect(lp); lp.connect(lp2); lp2.connect(g);
    var p = rig.panner(o.pan || 0);
    g.connect(p); p.connect(o.to || rig.out);
    return g;
  }

  /* =======================================================================
   * 6. THE CHAPTERS
   *
   * Every builder receives a fresh Rig and wires its layers into rig.out.
   * rig.out starts at gain 0 and is faded up by the crossfade machinery, so
   * builders never touch it.
   * ===================================================================== */

  var CHAPTERS = {};

  /* ---------------------------------------------------------------------
   * childhood_day - suburban morning: light birds, soft breeze.
   * The reference is a back garden at about 8 am: air moving in the trees,
   * a road far enough away to be felt rather than heard, and birds that are
   * busy but not loud.
   * TUNE: breeze.gain (how windy), bird stream 3.5-9 s (how busy the garden),
   *       road.gain (raise towards 0.16 for a house nearer the main road).
   * ------------------------------------------------------------------- */
  CHAPTERS.childhood_day = function (rig) {
    var breeze = rig.layer({ kind: 'pink', rate: 1.0, lp: 700, lpPoles: 2, gain: 0.34, pan: -0.25 });
    // The breeze breathes: the low pass drifts 480..900 Hz over ~30 s.
    rig.mod(rig.lib.mod('slowA'), breeze.lp.frequency, 480, 420, 0.6);
    rig.mod(rig.lib.mod('slowB'), breeze.gain.gain, 0.20, 0.20, 0.45);

    // A second, slower air layer on the other side widens the garden.
    var air = rig.layer({ kind: 'pink', rate: 0.86, lp: 520, lpPoles: 2, gain: 0.16, pan: 0.3 });
    rig.mod(rig.lib.mod('slowC'), air.gain.gain, 0.09, 0.14, 0.33);

    // The road, two streets over. Almost subliminal - remove it and the
    // ambience stops sounding suburban and starts sounding rural.
    rig.layer({ kind: 'brown', rate: 0.95, lp: 150, lpPoles: 2, gain: 0.10 });

    rig.every(3.5, 9.0, function (t) {
      birdPhrase(rig, t, { lo: 2200, hi: 3300, gain: 0.045, min: 2, max: 4 });
    });
    // A lower, lazier bird underneath the busy ones.
    rig.every(11, 26, function (t) {
      birdPhrase(rig, t, { lo: 1500, hi: 1900, gain: 0.03, min: 2, max: 3 });
    });
  };

  /* ---------------------------------------------------------------------
   * gaming_night - indoor night: crickets outside, faint keyboard and mouse
   * ticks, low room tone. The window is shut, so the crickets are behind
   * glass: quiet, and with their top end gone.
   * TUNE: hum gains (set to 0 if the tone bothers you), cricket.gain (window
   *       open = raise and lift cricket lp), typing stream 2.5-9 s.
   * ------------------------------------------------------------------- */
  CHAPTERS.gaming_night = function (rig) {
    // Room tone: the sound of a small room with a computer in it.
    rig.layer({ kind: 'brown', rate: 1.0, lp: 180, lpPoles: 2, gain: 0.30 });
    rig.layer({ kind: 'pink', rate: 0.9, lp: 420, lpPoles: 2, gain: 0.07, pan: 0.2 });

    // Power supply / monitor hum. Very low: it is texture, not a note.
    rig.tone(100, 0.006, -0.15);
    rig.tone(200, 0.0028, 0.15);

    // Crickets through a closed window: band passed, then low passed again.
    var cr1 = rig.layer({ kind: 'white', rate: 1.0, bp: [3900, 9], lp: 5000, gain: 0, pan: -0.45 });
    rig.mod(rig.lib.cricket(), cr1.gain.gain, 0, 0.13, 0.97);
    var cr2 = rig.layer({ kind: 'white', rate: 1.05, bp: [4300, 10], lp: 5000, gain: 0, pan: 0.5 });
    rig.mod(rig.lib.cricket(), cr2.gain.gain, 0, 0.095, 1.09);

    // Gaming means bursts of input, not steady typing.
    rig.every(3.5, 12.0, function (t) {
      typingBurst(rig, t, { min: 3, max: 7, gain: 0.85 });
    });
    rig.every(6, 20, function (t) {
      mouseClick(rig, t, { pan: rnd(0.1, 0.4) });
      if (coin(0.4)) mouseClick(rig, t + rnd(0.3, 0.9), { pan: rnd(0.1, 0.4) });
    });
  };

  /* ---------------------------------------------------------------------
   * flight - airport / plane: distant jet hum, cabin white noise, occasional
   * soft chime. The cabin is mostly a wall of low passed hiss with a low
   * engine core under it; the chime is what makes the ear say "aeroplane".
   * TUNE: hiss.gain (cabin loudness), engine tone gains, chime stream 25-60 s.
   * ------------------------------------------------------------------- */
  CHAPTERS.flight = function (rig) {
    // Small cabin reverb, used only by the chime.
    var conv = rig.mk('conv');
    conv.buffer = rig.lib.impulse('cabin');
    var wet = rig.mk('gain'); wet.gain.value = 0.20;
    conv.connect(wet); wet.connect(rig.out);

    // Cabin hiss - the dominant layer.
    var hiss = rig.layer({ kind: 'pink', rate: 1.0, hp: 90, lp: 1100, lpPoles: 2, gain: 0.38, pan: -0.2 });
    rig.mod(rig.lib.mod('slowA'), hiss.lp.frequency, 950, 350, 0.4);
    var hiss2 = rig.layer({ kind: 'pink', rate: 1.11, hp: 90, lp: 1000, lpPoles: 2, gain: 0.30, pan: 0.25 });

    // Engine core.
    rig.layer({ kind: 'brown', rate: 1.0, lp: 140, lpPoles: 2, gain: 0.42 });
    // Two close tones beat against each other about 1.6 times a second: that
    // slow throb is the giveaway of a turbofan.
    rig.tone(84, 0.012, -0.1);
    rig.tone(85.6, 0.010, 0.1);
    rig.tone(168, 0.005, 0);

    // Seatbelt / boarding chime.
    rig.every(25, 60, function (t) {
      chime(rig, t, { gain: 0.05, two: coin(0.5), send: conv, pan: rnd(-0.3, 0.3) });
    });
  };

  /* ---------------------------------------------------------------------
   * new_york - city: layered traffic hum, distant horns, subway rumble.
   * Three depths at once: the wash of the whole city, individual vehicles
   * crossing the stereo field, and the ground shaking every half minute.
   * TUNE: passBy stream 5-12 s (traffic density), horn stream 9-26 s,
   *       subway swell 25-55 s.
   * ------------------------------------------------------------------- */
  CHAPTERS.new_york = function (rig) {
    var wash = rig.layer({ kind: 'pink', rate: 1.0, lp: 620, lpPoles: 2, gain: 0.38, pan: -0.3 });
    rig.mod(rig.lib.mod('slowA'), wash.lp.frequency, 430, 420, 0.8);
    var wash2 = rig.layer({ kind: 'pink', rate: 0.92, lp: 560, lpPoles: 2, gain: 0.30, pan: 0.3 });
    rig.mod(rig.lib.mod('slowB'), wash2.gain.gain, 0.18, 0.16, 0.6);

    // Tyres on asphalt - the mid band that makes traffic sound wet and wide.
    rig.layer({ kind: 'pink', rate: 1.06, bp: [1150, 0.9], lp: 2600, gain: 0.11 });

    // The street floor.
    rig.layer({ kind: 'brown', rate: 1.0, lp: 90, lpPoles: 2, gain: 0.34 });

    // Subway: a swell that arrives from below every half minute or so.
    var sub = rig.layer({ kind: 'brown', rate: 0.8, lp: 70, lpPoles: 2, gain: 0 });
    rig.every(25, 55, function (t) {
      var dur = rnd(7, 12);
      var p = sub.gain.gain;
      p.cancelScheduledValues(t);
      p.setValueAtTime(paramValue(p), t);
      p.linearRampToValueAtTime(0.5, t + dur * 0.4);
      p.linearRampToValueAtTime(0.42, t + dur * 0.6);
      p.linearRampToValueAtTime(0, t + dur);
    });

    rig.every(5, 12, function (t) { passBy(rig, t, { gain: rnd(0.13, 0.22) }); });
    rig.every(9, 26, function (t) { carHorn(rig, t, { gain: rnd(0.03, 0.055) }); });
  };

  /* ---------------------------------------------------------------------
   * campus_day - bright outdoor: birds, light chatter texture.
   * Same outdoor family as childhood_day, but the defining element is people:
   * two talkers plus a wash of crowd, scattered wide, always low passed so no
   * one can try to make out a word.
   * TUNE: talker gains, wash gain, bird stream 4-11 s.
   * ------------------------------------------------------------------- */
  CHAPTERS.campus_day = function (rig) {
    // Brighter, more open breeze than the suburb.
    var breeze = rig.layer({ kind: 'pink', rate: 1.0, lp: 1100, lpPoles: 2, gain: 0.24, pan: -0.3 });
    rig.mod(rig.lib.mod('slowA'), breeze.lp.frequency, 800, 500, 0.5);
    rig.layer({ kind: 'pink', rate: 0.9, lp: 900, lpPoles: 2, gain: 0.16, pan: 0.35 });
    rig.layer({ kind: 'brown', rate: 1.0, lp: 200, lpPoles: 2, gain: 0.14 });

    // Crowd wash: unvoiced babble, the sound of a quad full of people who are
    // all too far away to be individuals.
    var wash = rig.layer({ kind: 'pink', rate: 1.0, bp: [700, 0.8], lp: 2200, gain: 0 });
    rig.mod(rig.lib.mod('babble'), wash.gain.gain, 0.02, 0.10, 0.55);

    // Two nearer voices.
    talker(rig, { pitch: 122, f1: 540, f2: 1450, gain: 0.05, pan: -0.5, lp: 2000, rate: 1.0 });
    talker(rig, { pitch: 196, f1: 640, f2: 1800, gain: 0.038, pan: 0.55, lp: 2100, rate: 1.13 });

    rig.every(4, 11, function (t) {
      birdPhrase(rig, t, { lo: 2400, hi: 3400, gain: 0.04, min: 2, max: 5 });
    });
  };

  /* ---------------------------------------------------------------------
   * office_day - soft office murmur, AC hum, occasional page turn.
   * The air handling is the loudest thing in the room and nobody notices it,
   * which is exactly the effect wanted. Murmur is more distant and duller than
   * on campus; no birds; paper and the odd keystroke instead.
   * TUNE: ac.gain, murmur talker gains, page stream 12-35 s.
   * ------------------------------------------------------------------- */
  CHAPTERS.office_day = function (rig) {
    // The AC: a broad low whoosh that breathes very slowly.
    var ac = rig.layer({ kind: 'pink', rate: 1.0, hp: 70, lp: 420, lpPoles: 2, gain: 0.46 });
    rig.mod(rig.lib.mod('slowC'), ac.gain.gain, 0.38, 0.12, 0.25);
    // Its high whoosh, from the vent itself.
    rig.layer({ kind: 'pink', rate: 1.08, bp: [1400, 0.6], lp: 3000, gain: 0.05, pan: 0.4 });
    // Building floor.
    rig.layer({ kind: 'brown', rate: 1.0, lp: 150, lpPoles: 2, gain: 0.22 });

    // Murmur: quieter, duller and further away than campus_day.
    var wash = rig.layer({ kind: 'pink', rate: 1.0, bp: [620, 0.8], lp: 1600, gain: 0 });
    rig.mod(rig.lib.mod('babble'), wash.gain.gain, 0.012, 0.055, 0.4);
    talker(rig, { pitch: 116, f1: 500, f2: 1400, gain: 0.032, pan: -0.4, lp: 1500, rate: 0.9 });
    talker(rig, { pitch: 178, f1: 600, f2: 1700, gain: 0.026, pan: 0.45, lp: 1500, rate: 1.05 });

    rig.every(12, 35, function (t) { pageTurn(rig, t, { gain: 0.115 }); });
    // Somebody, somewhere, is typing.
    rig.every(10, 25, function (t) {
      typingBurst(rig, t, { min: 2, max: 6, gain: 0.4, pan: rnd(-0.5, 0.5) });
    });
  };

  /* ---------------------------------------------------------------------
   * night_build - quiet late night: crickets, optional rain (off), sparse key
   * ticks. Deliberately the quietest of the indoor chapters. The window is
   * open, so the crickets are brighter and closer than in gaming_night, and
   * the typing is slow: this is thinking, not playing.
   * TUNE: rainTarget (level when rain is switched on), cricket gains,
   *       typing stream 7-22 s.
   * ------------------------------------------------------------------- */
  CHAPTERS.night_build = function (rig, opts) {
    var RAIN_TARGET = 0.22;   // rain layer level when on
    var RAIN_LOW_TARGET = 0.14;

    rig.layer({ kind: 'brown', rate: 1.0, lp: 160, lpPoles: 2, gain: 0.24 });
    rig.layer({ kind: 'pink', rate: 0.93, lp: 380, lpPoles: 2, gain: 0.05, pan: -0.2 });

    // Window open: crickets are present, and there are three of them.
    var cr1 = rig.layer({ kind: 'white', rate: 1.0, bp: [4200, 8], lp: 6000, gain: 0, pan: -0.5 });
    rig.mod(rig.lib.cricket(), cr1.gain.gain, 0, 0.175, 0.95);
    var cr2 = rig.layer({ kind: 'white', rate: 1.04, bp: [4600, 9], lp: 6000, gain: 0, pan: 0.55 });
    rig.mod(rig.lib.cricket(), cr2.gain.gain, 0, 0.13, 1.11);
    var cr3 = rig.layer({ kind: 'white', rate: 0.97, bp: [3800, 11], lp: 5200, gain: 0, pan: 0.15 });
    rig.mod(rig.lib.cricket(), cr3.gain.gain, 0, 0.07, 0.88);

    // Rain, built but silent. setOption('rain', true) ramps it up over 2.5 s.
    var rainHi = rig.layer({ kind: 'pink', rate: 1.0, hp: 500, lp: 5200, lpPoles: 2, gain: 0, pan: -0.35 });
    var rainHi2 = rig.layer({ kind: 'pink', rate: 1.09, hp: 600, lp: 5200, lpPoles: 2, gain: 0, pan: 0.4 });
    var rainLow = rig.layer({ kind: 'brown', rate: 1.0, lp: 260, lpPoles: 2, gain: 0 });
    var rainOn = false;
    var dripStream = { armed: false };

    rig.setOption = function (name, value) {
      if (name !== 'rain') return;
      var on = !!value;
      if (on === rainOn) return;
      rainOn = on;
      var now = rig.ctx.currentTime, d = 2.5;
      rampLinear(rainHi.gain.gain, now, d, on ? RAIN_TARGET : 0);
      rampLinear(rainHi2.gain.gain, now, d, on ? RAIN_TARGET * 0.8 : 0);
      rampLinear(rainLow.gain.gain, now, d, on ? RAIN_LOW_TARGET : 0);
      dripStream.armed = on;
    };
    if (opts && opts.rain) rig.setOption('rain', true);

    rig.every(0.35, 1.4, function (t) {
      if (dripStream.armed) drip(rig, t, { gain: rnd(0.008, 0.02) });
    });

    // Slow, sparse typing.
    rig.every(7, 22, function (t) {
      typingBurst(rig, t, { min: 2, max: 6, gain: 0.7 });
    });
    rig.every(20, 60, function (t) { mouseClick(rig, t, { pan: 0.3 }); });
    // A car, somewhere, very far away. Once a minute or two.
    rig.every(55, 140, function (t) {
      passBy(rig, t, { gain: 0.045, lo: 150, hi: 420, top: 900, dur: rnd(5, 7) });
    });
  };

  /* ---------------------------------------------------------------------
   * winter - soft wind, snow-muffled quiet.
   * Snow absorbs the top end and most of the reflections, so this chapter is
   * defined as much by what is missing as by what is there: no birds, no
   * traffic, nothing above about 1.8 kHz, and long gaps where the wind drops
   * to almost nothing.
   * TUNE: gust depth in the mod() calls (0.15 base + 0.85 depth = very gusty),
   *       whistle.gain (raise for a bleaker, more exposed feel).
   * ------------------------------------------------------------------- */
  CHAPTERS.winter = function (rig) {
    // Low wind body.
    var low = rig.layer({ kind: 'brown', rate: 1.0, lp: 240, lpPoles: 2, gain: 0 });
    rig.mod(rig.lib.mod('gustA'), low.gain.gain, 0.12, 0.34, 0.5);

    // Mid wind, panning slowly across the field.
    var mid = rig.layer({ kind: 'pink', rate: 1.0, bp: [420, 1.1], lp: 900, lpPoles: 2, gain: 0, pan: 0 });
    rig.mod(rig.lib.mod('gustB'), mid.gain.gain, 0.03, 0.22, 0.42);
    rig.mod(rig.lib.mod('slowA'), mid.bp.frequency, 260, 420, 0.35);
    if (mid.out.pan) rig.lfo(0.031, 0, 0.65, mid.out.pan);

    // The whistle around an edge. The 'peak' curve is cubed, so this stays at
    // zero through ordinary wind and only speaks at the top of a gust.
    var whistle = rig.layer({ kind: 'pink', rate: 1.0, bp: [980, 5.5], lp: 1800, gain: 0, pan: -0.4 });
    rig.mod(rig.lib.mod('peakA'), whistle.gain.gain, 0, 0.075, 0.5);
    rig.mod(rig.lib.mod('slowB'), whistle.bp.frequency, 820, 420, 0.6);

    // Snow-muffled floor: almost silent, just enough to say the world is there.
    rig.layer({ kind: 'brown', rate: 0.85, lp: 110, lpPoles: 2, gain: 0.16 });
  };

  /* ---------------------------------------------------------------------
   * studio - movie set / editing bay: projector whir, room tone, film-reel
   * click. The whir is a 24 Hz amplitude gate on band passed noise, which is
   * literally what a projector is: 24 mechanical events per second.
   * TUNE: whir.gain, the 24 in lib.projector() (change to 25 for PAL),
   *       click stream 5-16 s.
   * ------------------------------------------------------------------- */
  CHAPTERS.studio = function (rig) {
    var conv = rig.mk('conv');
    conv.buffer = rig.lib.impulse('room');
    var wet = rig.mk('gain'); wet.gain.value = 0.22;
    conv.connect(wet); wet.connect(rig.out);

    // Projector whir. floor 0.35 in the gate buffer keeps the whir continuous
    // with a rhythmic bump on top, rather than a stuttering chop.
    var whir = rig.layer({ kind: 'pink', rate: 1.0, bp: [900, 1.4], lp: 2600, gain: 0, pan: 0.35 });
    rig.mod(rig.lib.projector(), whir.gain.gain, 0, 0.10, 1.0);
    var whir2 = rig.layer({ kind: 'pink', rate: 1.07, bp: [1600, 2.2], lp: 3200, gain: 0, pan: 0.45 });
    rig.mod(rig.lib.projector(), whir2.gain.gain, 0, 0.035, 1.0);

    // Motor: harmonics of the frame rate.
    rig.layer({ kind: 'brown', rate: 1.0, lp: 220, lpPoles: 2, gain: 0.20, pan: 0.3 });
    rig.tone(48, 0.010, 0.3);
    rig.tone(96, 0.005, 0.3);

    // Edit-bay room tone.
    rig.layer({ kind: 'brown', rate: 0.9, lp: 130, lpPoles: 2, gain: 0.22 });
    rig.layer({ kind: 'pink', rate: 1.0, lp: 900, lpPoles: 2, gain: 0.06, pan: -0.3 });

    // Sprocket and splice clicks.
    rig.every(5, 16, function (t) {
      click(rig, t, { freq: rnd(1900, 2800), q: 2.5, gain: rnd(0.07, 0.13), pan: rnd(0.1, 0.5), send: conv });
      if (coin(0.3)) click(rig, t + rnd(0.06, 0.14), { freq: rnd(1600, 2400), gain: 0.07, pan: 0.35, send: conv });
    });
  };

  /* ---------------------------------------------------------------------
   * theater - auditorium room tone, faint projector.
   * The same projector as studio, but heard from the back of a big empty room
   * through a booth window: duller, quieter, and mostly reverb. The room tone
   * is wide and very low. Distinguishing it from studio is the size.
   * TUNE: wet.gain (how big the room feels), proj gain, creak stream 30-75 s.
   * ------------------------------------------------------------------- */
  CHAPTERS.theater = function (rig) {
    var conv = rig.mk('conv');
    conv.buffer = rig.lib.impulse('hall');
    var wet = rig.mk('gain'); wet.gain.value = 0.5;
    conv.connect(wet); wet.connect(rig.out);

    // Big, wide, low room tone: two decorrelated sources hard-ish panned.
    rig.layer({ kind: 'brown', rate: 1.0, lp: 200, lpPoles: 2, gain: 0.30, pan: -0.8 });
    rig.layer({ kind: 'brown', rate: 1.09, lp: 200, lpPoles: 2, gain: 0.28, pan: 0.8 });
    rig.layer({ kind: 'pink', rate: 1.0, lp: 700, lpPoles: 2, gain: 0.09, pan: -0.5 });
    // Air handling, high in the ceiling.
    var air = rig.layer({ kind: 'pink', rate: 0.95, lp: 300, lpPoles: 2, gain: 0.12, pan: 0.4 });
    rig.mod(rig.lib.mod('slowC'), air.gain.gain, 0.08, 0.08, 0.3);

    // The projector, behind glass at the back: band limited hard, low level,
    // and pushed into the reverb so it arrives as room rather than machine.
    var proj = rig.layer({ kind: 'pink', rate: 1.0, bp: [760, 1.2], lp: 1500, lpPoles: 2, gain: 0, pan: 0.5, to: conv });
    rig.mod(rig.lib.projector(), proj.gain.gain, 0.006, 0.05, 1.0);
    var projDry = rig.layer({ kind: 'pink', rate: 1.03, bp: [700, 1.4], lp: 1300, lpPoles: 2, gain: 0, pan: 0.5 });
    rig.mod(rig.lib.projector(), projDry.gain.gain, 0.002, 0.018, 1.0);

    // An empty auditorium is never quite silent.
    rig.every(30, 75, function (t) { creak(rig, t, { gain: rnd(0.045, 0.10), send: conv }); });
  };

  /* ---------------------------------------------------------------------
   * end_meadow - open air, birds, warm breeze.
   * The widest and driest chapter: no reverb, no machines, no people. Gusts
   * move through grass, two bird species answer each other, and a thin insect
   * shimmer sits on top to say summer.
   * TUNE: rustle.gain (long grass vs short), insect gain (very small on
   *       purpose - it is felt, not heard), bird streams.
   * ------------------------------------------------------------------- */
  CHAPTERS.end_meadow = function (rig) {
    // Warm breeze, gusting.
    var breeze = rig.layer({ kind: 'pink', rate: 1.0, lp: 640, lpPoles: 2, gain: 0, pan: -0.35 });
    rig.mod(rig.lib.mod('gustA'), breeze.gain.gain, 0.14, 0.22, 0.4);
    rig.mod(rig.lib.mod('slowA'), breeze.lp.frequency, 480, 380, 0.45);
    var breeze2 = rig.layer({ kind: 'pink', rate: 0.88, lp: 560, lpPoles: 2, gain: 0, pan: 0.4 });
    rig.mod(rig.lib.mod('gustB'), breeze2.gain.gain, 0.10, 0.18, 0.34);

    // Grass. The rustle follows the gusts, slightly behind them.
    var rustle = rig.layer({ kind: 'pink', rate: 1.0, bp: [1900, 0.8], lp: 3400, gain: 0, pan: 0.25 });
    rig.mod(rig.lib.mod('gustA'), rustle.gain.gain, 0.012, 0.06, 0.37);

    // Open ground.
    rig.layer({ kind: 'brown', rate: 1.0, lp: 180, lpPoles: 2, gain: 0.16 });

    // Insect shimmer: steady, tiny, and capped well below the harsh region.
    rig.layer({ kind: 'white', rate: 1.0, bp: [4600, 6], lp: 5600, gain: 0.028, pan: -0.6 });

    rig.every(3.5, 9, function (t) {
      birdPhrase(rig, t, { lo: 2300, hi: 3300, gain: 0.045, min: 2, max: 4 });
    });
    rig.every(6, 15, function (t) { birdWhistle(rig, t, { gain: 0.032 }); });
    // A bird at the far edge of the field.
    rig.every(10, 25, function (t) {
      birdPhrase(rig, t, { lo: 1700, hi: 2100, gain: 0.016, min: 1, max: 3 });
    });
  };

  function rampLinear(param, now, dur, target) {
    try { param.cancelScheduledValues(now); } catch (e) {}
    param.setValueAtTime(paramValue(param), now);
    param.linearRampToValueAtTime(target, now + dur);
  }

  /* ---------------------------------------------------------------------
   * CHAPTER TRIM - loudness matching, measured rather than guessed.
   *
   * The chapters are built to sound right, not to sound equal, so left alone
   * they arrived 9 dB apart: new_york at -40 dBFS RMS against childhood_day at
   * -49. On a page where a scroll changes the chapter, that reads as the
   * volume jumping, which is worse than any individual chapter being slightly
   * off. Each number below multiplies its chapter bus to aim every bed at
   * -37.5 dBFS RMS, which puts the steady part of the programme near -26 dBFS
   * peak. Measured in Chrome with one 6 s window per chapter.
   *
   * What this does and does not buy you: the 9 dB systematic spread is gone,
   * so no scene change reads as the volume moving. It is not a limiter. A
   * chapter carried by sparse events still wanders about 2 dB from window to
   * window - childhood_day reads -35 with a bird in it and -38 without - and
   * that wander is the scene breathing, not an error to tune out.
   *
   * TO RE-MEASURE after changing a chapter:
   *   1. open test.html, switch the sound on
   *   2. select the chapter, wait for the crossfade to settle
   *   3. in the console: await __level(6)   -- use 20 for a sparse chapter,
   *      and take two readings before you believe either of them
   *   4. newTrim = oldTrim * 10^((-37.5 - measuredRms) / 20)
   * Or move every chapter together by changing MASTER_VOLUME instead - that
   * is the volume control, this table is only the matching.
   * ------------------------------------------------------------------- */
  var CHAPTER_TRIM = {
    childhood_day: 3.80,   // measured -49.1 dBFS RMS
    gaming_night:  2.09,   // measured -43.9
    flight:        1.36,   // measured -40.2
    // new_york needs a longer window than the rest: its horns and its subway
    // are sparse and strong, so a 6 s reading lands anywhere in a 1 dB band
    // depending on whether a train went past. This number comes from two 20 s
    // windows (-38.8 and -38.5) and reads -37.8 at the corrected value. Its
    // peaks are the widest-ranging of the eleven, -26 dBFS between events and
    // about -22 when a horn or a train lands. That is the horn doing its job;
    // lower this if a human auditions it and finds it startling.
    new_york:      1.55,   // measured -38.65 over 2 x 20 s
    campus_day:    2.99,   // measured -47.0
    office_day:    1.66,   // measured -41.9
    night_build:   2.69,   // measured -46.1
    winter:        1.57,   // measured -41.4
    studio:        2.40,   // measured -45.1
    theater:       2.57,   // measured -45.7
    end_meadow:    2.51    // measured -45.5
  };

  var CHAPTER_KEYS = [];
  for (var k in CHAPTERS) if (CHAPTERS.hasOwnProperty(k)) CHAPTER_KEYS.push(k);

  /* =======================================================================
   * 7. THE FACTORY
   * ===================================================================== */

  /**
   * createAmbient(options)
   *   options.volume   master gain when enabled (default MASTER_VOLUME)
   *   options.crossfade  seconds between chapters (default 2.0)
   *   options.rain     start night_build with rain on (default false)
   *
   * Returns { start, setChapter, setEnabled, enabled, dispose,
   *           setOption, chapters, context, tap }
   * The last four are extras; the first five are the contract.
   */
  function createAmbient(options) {
    options = options || {};
    var volume = typeof options.volume === 'number' ? options.volume : MASTER_VOLUME;
    var crossfade = typeof options.crossfade === 'number' ? options.crossfade : CROSSFADE_S;
    var chapterOpts = { rain: !!options.rain };

    var Ctor = getAudioContextCtor();
    var supported = !!Ctor;

    var ctx = null;
    var master = null, bus = null;
    var lib = null;
    var current = null;      // { key, rig }
    var outgoing = [];       // rigs still fading out
    var pendingKey = null;   // chapter chosen before the sound was switched on
    var isEnabled = false;
    var disposed = false;
    var timer = null;
    var suspendTimer = null;
    var taps = [];

    /* ---- the shared generated-asset library ---------------------------
     * Everything here is built once, on first use, and reused by every
     * chapter for the life of the module. This is what keeps the CPU and the
     * memory flat no matter how many times the reader scrolls back and forth.
     * ------------------------------------------------------------------ */
    function makeLib(ctx) {
      var noiseCache = {}, modCache = {}, impCache = {}, cricketCache = null, projCache = null;
      // Buffer lengths: long enough that the loop is not recognisable once
      // filtered, short enough to stay under ~2.5 MB in total.
      var NOISE_SECONDS = { white: 2.0, pink: 5.0, brown: 6.0 };
      return {
        noise: function (kind) {
          if (!noiseCache[kind]) noiseCache[kind] = makeNoiseBuffer(ctx, NOISE_SECONDS[kind] || 3, kind);
          return noiseCache[kind];
        },
        // Named slow-modulation curves. Different names = different random
        // shapes, so two layers using 'slowA' and 'slowB' never move together.
        mod: function (name) {
          if (!modCache[name]) {
            if (name === 'babble') modCache[name] = makeBabbleBuffer(ctx, 14);
            else if (name === 'drift') modCache[name] = makeSmoothModBuffer(ctx, 9, [1, 2, 3, 5]);
            // 'peak*' curves are cubed, so they sit near zero and only open up
            // on the strongest peaks. Use them for events that should happen
            // at the top of a gust and nowhere else.
            else if (name.indexOf('peak') === 0) modCache[name] = makeSmoothModBuffer(ctx, 26, [1, 2, 3, 5, 8], 3);
            else if (name.indexOf('gust') === 0) modCache[name] = makeSmoothModBuffer(ctx, 26, [1, 2, 3, 5, 8]);
            else modCache[name] = makeSmoothModBuffer(ctx, 30, [1, 2, 3, 5, 7]);
          }
          return modCache[name];
        },
        cricket: function () {
          if (!cricketCache) cricketCache = makeCricketBuffer(ctx, 8, 0.55, 3);
          return cricketCache;
        },
        projector: function () {
          // 24 frames per second. Use 25 for a PAL telecine, 18 for Super 8.
          if (!projCache) projCache = makeProjectorBuffer(ctx, 2, 24, 0.35);
          return projCache;
        },
        impulse: function (name) {
          if (!impCache[name]) {
            if (name === 'cabin') impCache[name] = makeImpulse(ctx, 1.0, 3.2, 0.25);
            else if (name === 'hall') impCache[name] = makeImpulse(ctx, 2.2, 2.2, 0.30);
            else impCache[name] = makeImpulse(ctx, 0.9, 2.8, 0.40);
          }
          return impCache[name];
        }
      };
    }

    /* ---- context lifecycle -------------------------------------------- */

    // Called ONLY from setEnabled(true), i.e. inside a user gesture. Both
    // halves matter: Safari wants the context constructed in the gesture,
    // Chrome wants resume() called in it.
    function ensureContext() {
      if (ctx || !supported || disposed) return !!ctx;
      try {
        ctx = new Ctor();
      } catch (e) {
        supported = false;
        return false;
      }
      try {
        lib = makeLib(ctx);

        master = ctx.createGain();
        master.gain.value = 0;

        // Master tone shaping, then a high pass to keep sub rumble and any DC
        // out of the output stage.
        var shelf = ctx.createBiquadFilter();
        shelf.type = 'highshelf';
        shelf.frequency.value = MASTER_SHELF_HZ;
        shelf.gain.value = MASTER_SHELF_DB;

        var lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = MASTER_LP_HZ;
        lp.Q.value = 0.5;

        var hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = MASTER_HP_HZ;
        hp.Q.value = 0.7;

        bus = ctx.createGain();
        bus.gain.value = 1;
        bus.connect(shelf);
        shelf.connect(lp);
        lp.connect(hp);
        hp.connect(master);
        master.connect(ctx.destination);
        for (var i = 0; i < taps.length; i++) { try { master.connect(taps[i]); } catch (e) {} }
        return true;
      } catch (e) {
        // Half-built context: tear it down and go quiet for good.
        try { ctx.close(); } catch (e2) {}
        ctx = null;
        supported = false;
        return false;
      }
    }

    function resumeContext() {
      if (!ctx) return;
      if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
        try {
          var p = ctx.resume();
          if (p && p.catch) p.catch(function () {});
        } catch (e) {}
      }
    }

    function startTimer() {
      if (timer || !ctx) return;
      timer = setInterval(function () {
        if (!ctx || ctx.state !== 'running') return;
        var now = ctx.currentTime;
        if (current && current.rig) current.rig.tick(now);
      }, TICK_MS);
    }

    function stopTimer() {
      if (timer) { clearInterval(timer); timer = null; }
    }

    /* ---- chapter switching -------------------------------------------- */

    function buildChapter(key) {
      var fn = CHAPTERS[key];
      if (!fn) return null;
      var rig = new Rig(ctx, bus, lib);
      try {
        fn(rig, chapterOpts);
      } catch (e) {
        rig.dispose();
        return null;
      }
      return rig;
    }

    function retire(rig, dur) {
      if (!rig) return;
      equalPowerRamp(rig.out.gain, ctx.currentTime, dur, 0, false);
      rig.streams.length = 0; // no new events while it dies
      outgoing.push(rig);
      var entry = rig;
      setTimeout(function () {
        var i = outgoing.indexOf(entry);
        if (i >= 0) outgoing.splice(i, 1);
        entry.dispose();
      }, dur * 1000 + 250);
    }

    function switchTo(key, fadeIn) {
      if (!ctx || disposed) return;
      if (current && current.key === key) return;
      var rig = buildChapter(key);
      if (!rig) return;
      if (current) retire(current.rig, crossfade);
      current = { key: key, rig: rig };
      var trim = CHAPTER_TRIM[key] || 1;
      equalPowerRamp(rig.out.gain, ctx.currentTime, fadeIn == null ? crossfade : fadeIn, trim, true);
      // Give the streams a first pass immediately so a chapter does not open
      // with an unnaturally empty half second.
      rig.tick(ctx.currentTime);
      startTimer();
    }

    /* ---- tab visibility ------------------------------------------------
     * A suspended context freezes currentTime, so every scheduled ramp and
     * every stream time picks up exactly where it left off on resume.
     * ------------------------------------------------------------------ */
    function onVisibility() {
      if (!ctx || disposed) return;
      if (typeof document === 'undefined') return;
      if (document.hidden) {
        stopTimer();
        try { ctx.suspend(); } catch (e) {}
      } else if (isEnabled) {
        resumeContext();
        startTimer();
      }
    }

    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', onVisibility, false);
    }

    /* ---- public API ---------------------------------------------------- */

    var api = {
      /**
       * Choose the opening chapter. Safe to call before the sound is enabled
       * (and that is the normal case): the key is remembered and the chapter
       * starts the moment the reader switches sound on.
       */
      start: function (chapterKey) {
        if (disposed) return api;
        if (!CHAPTERS[chapterKey]) return api;
        if (!ctx || !isEnabled) { pendingKey = chapterKey; return api; }
        switchTo(chapterKey, ENABLE_FADE_S);
        return api;
      },

      /** Crossfade to another chapter. Unknown keys are ignored. */
      setChapter: function (chapterKey) {
        if (disposed) return api;
        if (!CHAPTERS[chapterKey]) return api;
        if (!ctx || !isEnabled) { pendingKey = chapterKey; return api; }
        switchTo(chapterKey, crossfade);
        return api;
      },

      /**
       * The only entry point that may create or resume the AudioContext, so
       * it MUST be called from a real user gesture (a click or a keypress).
       */
      setEnabled: function (on) {
        on = !!on;
        if (disposed || on === isEnabled) return api;
        isEnabled = on;
        if (on) {
          if (!ensureContext()) { isEnabled = false; return api; }
          if (suspendTimer) { clearTimeout(suspendTimer); suspendTimer = null; }
          resumeContext();
          if (!current) switchTo(pendingKey || CHAPTER_KEYS[0], ENABLE_FADE_S);
          equalPowerRamp(master.gain, ctx.currentTime, ENABLE_FADE_S, volume, true);
          startTimer();
          // The visibilitychange listener only hears about *changes*. If the
          // tab was already hidden when the sound was switched on, no event is
          // coming, so ask once. A reader cannot click a button in a hidden
          // tab, but a site that calls setEnabled from anything other than a
          // click can land here, and a context left running in a hidden tab
          // would burn CPU with nobody listening.
          if (typeof document !== 'undefined' && document.hidden) onVisibility();
        } else if (ctx) {
          equalPowerRamp(master.gain, ctx.currentTime, DISABLE_FADE_S, 0, false);
          stopTimer();
          suspendTimer = setTimeout(function () {
            suspendTimer = null;
            if (!isEnabled && ctx) { try { ctx.suspend(); } catch (e) {} }
          }, SUSPEND_DELAY_MS);
        }
        return api;
      },

      enabled: function () { return isEnabled; },

      dispose: function () {
        if (disposed) return;
        disposed = true;
        isEnabled = false;
        stopTimer();
        if (suspendTimer) { clearTimeout(suspendTimer); suspendTimer = null; }
        if (typeof document !== 'undefined' && document.removeEventListener) {
          document.removeEventListener('visibilitychange', onVisibility, false);
        }
        var i;
        for (i = 0; i < outgoing.length; i++) outgoing[i].dispose();
        outgoing.length = 0;
        if (current) { current.rig.dispose(); current = null; }
        if (ctx) {
          try { master.disconnect(); } catch (e) {}
          try { var p = ctx.close(); if (p && p.catch) p.catch(function () {}); } catch (e) {}
          ctx = null;
        }
      },

      /* ---- extras (not part of the required contract) ---------------- */

      /** Per-chapter switches. Currently: setOption('rain', bool) in
       *  night_build. Remembered, so it also applies to future visits. */
      setOption: function (name, value) {
        if (name === 'rain') chapterOpts.rain = !!value;
        if (current && current.rig && current.rig.setOption) {
          try { current.rig.setOption(name, value); } catch (e) {}
        }
        return api;
      },

      /** The chapter keys this build knows about, in story order. */
      chapters: function () { return CHAPTER_KEYS.slice(); },

      /** The AudioContext once it exists, else null. For meters and tests. */
      context: function () { return ctx; },

      /** Connect an extra node (an AnalyserNode, say) to the master output. */
      tap: function (node) {
        if (!node) return api;
        taps.push(node);
        if (master) { try { master.connect(node); } catch (e) {} }
        return api;
      },

      /** False when the browser has no Web Audio at all. Everything else on
       *  this object stays callable and does nothing. */
      supported: function () { return supported; },

      /** Test hook: run the sparse-event scheduler once, by hand. check.js
       *  uses it to exercise every one-shot voice without waiting in real
       *  time. Harmless in production; nothing in the site should call it. */
      _tick: function () {
        if (ctx && current && current.rig) current.rig.tick(ctx.currentTime);
        return api;
      }
    };

    return api;
  }

  /* Exposed for the node sanity check in check.js. Not part of the API. */
  createAmbient._internals = {
    makeNoiseBuffer: makeNoiseBuffer,
    makeSmoothModBuffer: makeSmoothModBuffer,
    makeCricketBuffer: makeCricketBuffer,
    makeProjectorBuffer: makeProjectorBuffer,
    makeBabbleBuffer: makeBabbleBuffer,
    makeImpulse: makeImpulse,
    equalPowerRamp: equalPowerRamp,
    env: env,
    CHAPTER_KEYS: CHAPTER_KEYS,
    CHAPTER_TRIM: CHAPTER_TRIM,
    MASTER_VOLUME: MASTER_VOLUME
  };

  global.createAmbient = createAmbient;
  if (typeof module !== 'undefined' && module.exports) module.exports = createAmbient;

})(typeof window !== 'undefined' ? window : this);
