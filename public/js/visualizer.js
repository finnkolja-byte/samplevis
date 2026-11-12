// deterministic 1080x1920 constellation & piano roll renderer for 60fps preview and webcodecs export
class SampleVisualizer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.width = 1080;
    this.height = 1920;

    this.headerHeight = 0;
    this.pianoRollTop = 1390;
    this.skyTop = 0;
    this.skyHeight = this.pianoRollTop;
    this.skyCenterX = this.width * 0.5;
    this.skyCenterY = this.skyHeight * 0.48;

    this.params = {
      driftSpeed: 1.0,
      linkDistance: 240,
      minStarDistance: 80,
      bloomIntensity: 0.88,
      animeOpacity: 0.62,
      cameraMotion: 1.0,
      cutMode: 'chord', // 'chord' | 'single' | '2bar' | '4bar' | 'impact'
      loopIntroMidi: true,
      seamlessLoop: true,
      loopTransitionDuration: null, // defaults to 2 beats
      preDropDuration: 2.2,
      speedRamping: true,
      middleSpawnChance: 0.20,
      topStarLinkChance: 0.22,
      timeOfDay: 25,
      sunsetDropTransition: false,
      dropGlitch: true,
      autoFrame: true
    };

    this.project = {
      brand: 'aesttc',
      sampleNumber: '',
      title: 'untitled',
      bpm: 120,
      key: '',
      duration: 30.0,
      dropTime: 15.0,
      dropBar: 1,
      peaks: [],
      chordCutTimes: [],
      impactTimes: []
    };

    this.rawTracks = [];
    this.selectedTrackIds = new Set();
    this.activeNotes = [];
    this.starSeeds = [];
    this.chordTimelineMarkers = [];
    this.minPitch = 48;
    this.maxPitch = 84;

    this.activeVideos = [];
    this.aspectRatio = '9:16';

    this.bgStars = this._createBgStars(160);
    this.stardust = this._createStardust(90);
    this.bgWarpLines = this._createBgWarpLines(36);
    this.preDropSparkles = this._createPreDropSparkles(150);
  }

  setActiveVideos(videos) {
    this.activeVideos = Array.isArray(videos) ? videos : [];
  }

  setAspectRatio(ratio) {
    this.aspectRatio = ratio;
    const isWidescreen = ratio === '16:9';
    this.width = isWidescreen ? 1920 : 1080;
    this.height = isWidescreen ? 1080 : 1920;
    if (this.canvas) {
      this.canvas.width = this.width;
      this.canvas.height = this.height;
    }
    this.pianoRollTop = Math.round(this.height * (isWidescreen ? 0.65 : 0.724));
    this.pianoRollHeight = this.height - this.pianoRollTop;
    this.skyTop = 0;
    this.skyHeight = this.pianoRollTop;
    this.skyCenterX = this.width * 0.5;
    this.skyCenterY = this.skyHeight * 0.48;
    this.bgStars = this._createBgStars(160);
    this.stardust = this._createStardust(90);
    this.bgWarpLines = this._createBgWarpLines(36);
    this.preDropSparkles = this._createPreDropSparkles(150);
    this.rebuildNoteNodes();
  }

  getDropTime() {
    const dur = this.project?.duration || 30.0;
    return (typeof this.project?.dropTime === 'number' && !isNaN(this.project.dropTime))
      ? this.project.dropTime
      : (dur * 0.5);
  }

  _hash(n) {
    const s = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
    return s - Math.floor(s);
  }

  _createBgStars(count) {
    const arr = [];
    const dur = this.project?.duration || 29.09;
    const baseFreq = (Math.PI * 2) / dur;
    for (let i = 0; i < count; i++) {
      const warmth = this._hash(i * 3.7 + 1.2);
      const rawSpeed = 0.6 + this._hash(i * 23.9) * 2.0;
      // quantize speed to an integer harmonic of the loop frequency so twinkle(dur) === twinkle(0)
      const harmonicK = Math.max(1, Math.round(rawSpeed / baseFreq));
      const speed = harmonicK * baseFreq;
      arr.push({
        x: this._hash(i * 3.1) * this.width,
        y: this.skyTop + this._hash(i * 7.3) * (this.height - this.skyTop),
        r: 0.6 + this._hash(i * 11.7) * 1.5,
        phase: this._hash(i * 19.3) * Math.PI * 2,
        speed,
        warmth
      });
    }
    return arr;
  }

  _getLoopTransitionInfo(t) {
    if (!this.params.seamlessLoop) {
      return { inTransition: false, progress: 0, loopFade: 1.0, clipFade: 1.0, loopWin: 0.85 };
    }
    const dur = this.project?.duration || 30.0;
    const bpm = parseFloat(this.project?.bpm) || 120;
    const secPerBeat = 60 / bpm;
    // 2-beat outro turnaround window
    const loopWin = this.params.loopTransitionDuration || Math.max(0.75, Math.min(1.2, secPerBeat * 2));
    if (t > dur - loopWin) {
      const p = Math.max(0, Math.min(1.0, (t - (dur - loopWin)) / loopWin));
      const easeP = p * p * (3 - 2 * p);
      const loopFade = Math.max(0, 1.0 - easeP);
      // dissolve video clip by p = 0.70 so the final ~250ms matches frame 0
      const clipProg = Math.min(1.0, p / 0.70);
      const clipEase = clipProg * clipProg * (3 - 2 * clipProg);
      const clipFade = Math.max(0, 1.0 - clipEase);
      return { inTransition: true, progress: p, loopFade, clipFade, loopWin };
    }
    return { inTransition: false, progress: 0, loopFade: 1.0, clipFade: 1.0, loopWin };
  }

  _getLoopFade(t) {
    return this._getLoopTransitionInfo(t).loopFade;
  }

  _getPreDropLift(t) {
    const dropTime = this.getDropTime();
    const dur = this.params?.preDropDuration || 2.2;
    if (t >= dropTime - dur && t < dropTime) {
      const p = (t - (dropTime - dur)) / dur;
      // slow initial float followed by steep pre-drop acceleration
      const ease = 0.06 * Math.pow(p, 1.6) + 0.94 * Math.pow(p, 4.8);
      return { pLift: p, liftEase: ease, isLifting: true, dur };
    }
    return { pLift: 0, liftEase: 0, isLifting: false, dur };
  }

  _createStardust(count) {
    const arr = [];
    for (let i = 0; i < count; i++) {
      arr.push({
        x0: this._hash(i * 5.7) * this.width,
        y0: this.skyTop + this._hash(i * 9.1) * (this.height - this.skyTop),
        vx: (this._hash(i * 13.3) - 0.5) * 22,
        vy: -16 - this._hash(i * 17.7) * 32,
        size: 1.0 + this._hash(i * 29.1) * 2.4,
        hue: this._hash(i * 37.2) > 0.4 ? 38 : 215,
        phase: this._hash(i * 43.1) * Math.PI * 2
      });
    }
    return arr;
  }

  _createBgWarpLines(count) {
    const arr = [];
    for (let i = 0; i < count; i++) {
      arr.push({
        x: this._hash(i * 9.2 + 0.4) * this.width,
        y0: this._hash(i * 14.7 + 1.8) * this.height,
        width: 1.0 + this._hash(i * 18.3) * 2.2,
        speed: 420 + this._hash(i * 27.9) * 640,
        warmth: this._hash(i * 39.1), // 0: ethereal ice/lavender, 1: warm starlight
        baseAlpha: 0.14 + this._hash(i * 51.5) * 0.22,
        phase: this._hash(i * 63.7) * Math.PI * 2
      });
    }
    return arr;
  }

  _createPreDropSparkles(count) {
    const arr = [];
    for (let i = 0; i < count; i++) {
      const warmth = this._hash(i * 7.1 + 0.9);
      arr.push({
        x0: this._hash(i * 11.3 + 0.2) * this.width,
        y0: this._hash(i * 17.9 + 1.5) * this.height,
        speed: 300 + this._hash(i * 23.4) * 560, // pixels per second
        size: 1.1 + this._hash(i * 31.8) * 2.4, // radius
        warmth, // 0: icy diamond blue, 1: warm celestial gold
        twinkleSpeed: 9.0 + this._hash(i * 41.2) * 16.0,
        phase: this._hash(i * 59.7) * Math.PI * 2,
        driftX: (this._hash(i * 71.3) - 0.5) * 44
      });
    }
    return arr;
  }

  setProject(project) {
    this.project = {
      ...this.project,
      ...project
    };
    this.rawTracks = project.tracks || [];
    this.selectedTrackIds = new Set(
      this.rawTracks.filter((t) => t.defaultSelected).map((t) => t.id)
    );
    if (this.selectedTrackIds.size === 0 && this.rawTracks.length > 0) {
      this.selectedTrackIds.add(this.rawTracks[0].id);
    }
    this.bgStars = this._createBgStars(160);
    this.bgWarpLines = this._createBgWarpLines(36);
    this.preDropSparkles = this._createPreDropSparkles(150);
    this.rebuildNoteNodes();
  }

  toggleTrack(trackId, enabled) {
    if (enabled) this.selectedTrackIds.add(trackId);
    else this.selectedTrackIds.delete(trackId);
    this.rebuildNoteNodes();
  }

  rebuildNoteNodes() {
    const notes = [];
    const dropTime = this.getDropTime();
    const duration = this.project.duration || 29.09;

    for (const track of this.rawTracks) {
      if (!this.selectedTrackIds.has(track.id)) continue;
      const trackNotes = track.notes || [];
      let maxNoteTime = 0;
      for (const raw of trackNotes) {
        const time = (raw.time !== undefined) ? raw.time : (raw.startTime !== undefined ? raw.startTime : 0);
        const midi = (raw.midi !== undefined) ? raw.midi : (raw.pitch !== undefined ? raw.pitch : 60);
        const duration = (raw.duration !== undefined) ? raw.duration : 0.5;
        const velocity = (raw.velocity !== undefined) ? raw.velocity : 0.8;
        const n = { ...raw, time, midi, duration, velocity, trackId: track.id };
        if (n.time > maxNoteTime) maxNoteTime = n.time;
        notes.push(n);
      }

      // mirror intro-only midi tracks into the drop when loopIntroMidi is enabled
      if (
        this.params.loopIntroMidi &&
        trackNotes.length > 0 &&
        maxNoteTime <= dropTime + 0.15 &&
        dropTime > 2 &&
        duration > dropTime + 2
      ) {
        for (const raw of trackNotes) {
          const origTime = (raw.time !== undefined) ? raw.time : (raw.startTime !== undefined ? raw.startTime : 0);
          const mirroredTime = origTime + dropTime;
          if (mirroredTime + 0.05 < duration) {
            const midi = (raw.midi !== undefined) ? raw.midi : (raw.pitch !== undefined ? raw.pitch : 60);
            const duration = (raw.duration !== undefined) ? raw.duration : 0.5;
            const velocity = (raw.velocity !== undefined) ? raw.velocity : 0.8;
            const origBeat = raw.beat !== undefined ? raw.beat : (origTime * (this.project.bpm || 120)) / 60;
            notes.push({
              ...raw,
              time: Number(mirroredTime.toFixed(4)),
              midi,
              duration,
              velocity,
              beat: Number((origBeat + (dropTime * (this.project.bpm || 120)) / 60).toFixed(4)),
              trackId: track.id,
              mirrored: true
            });
          }
        }
      }
    }

    notes.sort((a, b) => a.time - b.time || a.midi - b.midi);
    this.activeNotes = notes;

    if (notes.length > 0) {
      const pitches = notes.map((n) => n.midi);
      this.minPitch = Math.max(24, Math.min(...pitches) - 2);
      this.maxPitch = Math.min(108, Math.max(...pitches) + 2);
      if (this.maxPitch - this.minPitch < 12) {
        this.minPitch = Math.max(24, this.minPitch - 6);
        this.maxPitch = Math.min(108, this.maxPitch + 6);
      }
    } else {
      this.minPitch = 48;
      this.maxPitch = 84;
    }

    // build star trajectories for each note
    const pitchSpan = Math.max(1, this.maxPitch - this.minPitch);
    const bpm = this.project.bpm || 120;
    const secPerBar = (60 / bpm) * 4;
    const startY = 50;
    const endY = this.pianoRollTop - 110;
    const usableH = endY - startY;
    const W = this.width;

    // lowest 12 unique pitches spawn larger primary stars
    const uniquePitches = Array.from(new Set(notes.map((n) => n.midi))).sort((a, b) => a - b);
    const lowest12Set = new Set(uniquePitches.slice(0, 12));

    // flanking perimeter clusters framing left and right
    const introClusters = [
      { x: W * 0.26, y: startY + usableH * 0.22, tier: 0 },
      { x: W * 0.74, y: startY + usableH * 0.26, tier: 0 },
      { x: W * 0.24, y: startY + usableH * 0.50, tier: 1 },
      { x: W * 0.76, y: startY + usableH * 0.54, tier: 1 },
      { x: W * 0.27, y: startY + usableH * 0.78, tier: 2 },
      { x: W * 0.73, y: startY + usableH * 0.84, tier: 2 }
    ];

    const dropClusters = [
      { x: W * 0.17, y: startY + usableH * 0.16, tier: 0 },
      { x: W * 0.83, y: startY + usableH * 0.16, tier: 0 },
      { x: W * 0.20, y: startY + usableH * 0.42, tier: 1 },
      { x: W * 0.80, y: startY + usableH * 0.42, tier: 1 },
      { x: W * 0.18, y: startY + usableH * 0.68, tier: 2 },
      { x: W * 0.82, y: startY + usableH * 0.68, tier: 2 },
      { x: W * 0.18, y: startY + usableH * 0.86, tier: 2 },
      { x: W * 0.82, y: startY + usableH * 0.86, tier: 2 }
    ];

    const middleClusters = [
      { x: W * 0.5, y: startY + usableH * 0.18, tier: 0 },
      { x: W * 0.5, y: startY + usableH * 0.48, tier: 1 },
      { x: W * 0.5, y: startY + usableH * 0.76, tier: 2 }
    ];

    const seeds = [];
    const minStarDist = this.params.minStarDistance || 80;
    const middleChance = this.params.middleSpawnChance !== undefined ? this.params.middleSpawnChance : 0.20;

    for (let idx = 0; idx < notes.length; idx++) {
      const n = notes[idx];
      const h1 = this._hash(idx * 13.7 + n.midi * 7.1);
      const h2 = this._hash(idx * 29.3 + n.time * 19.7);
      const h3 = this._hash(idx * 41.9 + n.velocity * 53.1);
      const h4 = this._hash(idx * 67.3 + n.midi * 11.9);
      const hMid = this._hash(idx * 79.3 + n.midi * 23.1 + n.time * 7.9);

      const pitchNorm = (n.midi - this.minPitch) / pitchSpan;
      const isDropNote = n.time >= dropTime;
      const isMiddleSpawn = hMid < middleChance;

      const isLowest12 = lowest12Set.has(n.midi) || (n.midi - this.minPitch <= 12);
      let tier = 'mid';
      if (isLowest12 || pitchNorm < 0.28) {
        tier = 'low';
      } else if (pitchNorm > 0.68 || /sparkle|bell/i.test(n.track || '')) {
        tier = 'high';
      }

      let cluster;
      const safePitchNorm = isNaN(pitchNorm) ? 0.5 : Math.max(0, Math.min(1, pitchNorm));
      const pitchTier = Math.max(0, Math.min(2, Math.floor((1 - safePitchNorm) * 2.99)));

      if (isMiddleSpawn) {
        const matchingMid = middleClusters.filter((c) => c.tier === pitchTier);
        cluster = matchingMid.length > 0 ? matchingMid[0] : middleClusters[pitchTier % middleClusters.length];
      } else if (!isDropNote) {
        const phrase = Math.max(0, Math.floor(n.time / (secPerBar * 2)));
        const matching = introClusters.filter((c) => c.tier === pitchTier);
        const pool = matching.length > 0 ? matching : introClusters;
        cluster = pool[(phrase + idx + (isLowest12 ? 1 : 0)) % pool.length];
      } else {
        const phrase = Math.max(0, Math.floor((n.time - dropTime) / (secPerBar * 1.5)));
        const matching = dropClusters.filter((c) => c.tier === pitchTier);
        const pool = matching.length > 0 ? matching : dropClusters;
        cluster = pool[(phrase + Math.floor(h4 * 2) + idx) % pool.length];
      }

      if (!cluster) {
        cluster = { x: W * 0.5, y: startY + usableH * 0.5, tier: 1 };
      }

      const angle = idx * 2.3999632 + (h1 - 0.5) * 1.3;
      let spreadX;
      let spreadY;

      if (isMiddleSpawn) {
        spreadX = (h1 - 0.5) * 110 + Math.cos(angle) * (20 + h3 * 30);
        spreadY = (h2 - 0.5) * 80 + Math.sin(angle) * 35;
      } else {
        const clusterScatter = isDropNote ? (40 + Math.sqrt(h2) * 95) : (25 + Math.sqrt(h2) * 70);
        spreadX = Math.cos(angle) * (clusterScatter * (isDropNote ? 1.45 : 1.25)) + (h3 - 0.5) * (isDropNote ? 80 : 40);
        spreadY = Math.sin(angle) * (clusterScatter * 0.75) + (h2 - 0.5) * 50;
      }

      let x0 = cluster.x + spreadX;
      let y0 = Math.max(startY, Math.min(endY, cluster.y + spreadY));

      if (isMiddleSpawn) {
        x0 = Math.max(W * 0.38, Math.min(W * 0.62, x0));
      } else if (cluster.x < W * 0.5) {
        x0 = Math.max(75, Math.min(W * 0.40, x0));
      } else {
        x0 = Math.max(W * 0.60, Math.min(W - 75, x0));
      }

      // anti-clumping relaxation for concurrently visible stars
      for (let iter = 0; iter < 12; iter++) {
        let tooClose = false;
        for (let j = Math.max(0, idx - 18); j < idx; j++) {
          const prev = seeds[j];
          if (Math.abs(prev.note.time - n.time) > 8.5) continue;

          const dx = x0 - prev.x0;
          const dy = y0 - prev.y0;
          const dist = Math.hypot(dx, dy);

          if (dist < minStarDist) {
            tooClose = true;
            const overlap = minStarDist - dist;
            const repAngle = dist > 1 ? Math.atan2(dy, dx) : ((idx + iter) * 1.6180339887);
            x0 += Math.cos(repAngle) * (overlap * 0.72 + 6);
            y0 += Math.sin(repAngle) * (overlap * 0.72 + 6);
            if (isMiddleSpawn) {
              x0 = Math.max(400, Math.min(680, x0));
            } else if (cluster.x < 540) {
              x0 = Math.max(75, Math.min(420, x0));
            } else {
              x0 = Math.max(660, Math.min(this.width - 75, x0));
            }
            y0 = Math.max(startY, Math.min(endY, y0));
          }
        }
        if (!tooClose) break;
      }

      let arcDir;
      if (x0 < this.width * 0.46) {
        arcDir = -1;
      } else if (x0 > this.width * 0.54) {
        arcDir = 1;
      } else {
        arcDir = (idx % 2 === 0 ? -1 : 1) * (h3 > 0.15 ? 1 : -1);
      }

      const defiesGravity = h4 > 0.82;
      const speedMult = tier === 'high' ? 0.7 : (tier === 'mid' ? 0.9 : 1.0);
      const dropLateralBoost = isDropNote ? 1.25 : 1.0;

      let vx0 = 0;
      let ax = 0;
      let vy0 = 0;
      let ay = 0;

      if (defiesGravity) {
        vx0 = (h3 - 0.5) * (isMiddleSpawn ? 6.0 : 12.0) * speedMult * dropLateralBoost;
        vy0 = (h1 - 0.52) * 3.0 * speedMult;
      } else if (isMiddleSpawn) {
        vx0 = (3.5 + h1 * 4.0 + n.velocity * 2.5) * speedMult * (isDropNote ? 1.15 : 1.0);
        ax = (0.4 + h3 * 0.6) * speedMult * (isDropNote ? 1.15 : 1.0);
        vy0 = (4 + h2 * 4.5) * speedMult;
        ay = (1.5 + h4 * 1.8 + n.velocity * 0.8) * speedMult;
      } else {
        vx0 = (9 + h1 * 8 + n.velocity * 5) * speedMult * dropLateralBoost;
        ax = (1.2 + h3 * 1.5) * speedMult * dropLateralBoost;
        vy0 = (4 + h2 * 5) * speedMult;
        ay = (1.5 + h4 * 1.8 + n.velocity * 0.8) * speedMult;
      }

      const warmth = h4;
      const colorR = 255;
      let colorG = Math.round(230 + warmth * 20);
      let colorB = Math.round(155 + (1 - warmth) * 90);

      let radius = 1.6 + n.velocity * 1.5;
      if (tier === 'low') {
        radius = 5.2 + n.velocity * 4.2;
      } else if (tier === 'high') {
        radius = 1.1 + n.velocity * 0.8;
        colorG = Math.min(255, colorG + 15);
        colorB = Math.max(130, colorB - 20);
      }

      const topLinkChance = this.params.topStarLinkChance !== undefined ? this.params.topStarLinkChance : 0.22;
      const canLink = tier !== 'high' || (this._hash(idx * 47.9 + n.midi * 13.1 + n.time * 5.3) < topLinkChance);

      seeds.push({
        idx,
        note: n,
        tier,
        canLink,
        defiesGravity,
        x0,
        y0,
        arcDir,
        vx0,
        ax,
        vy0,
        ay,
        vx: arcDir * vx0,
        vy: vy0,
        freq1: 0.32 + h1 * 0.35,
        freq2: 0.75 + h2 * 0.55,
        amp1: tier === 'high' ? 6 + h3 * 6 : 10 + h3 * 10,
        amp2: tier === 'high' ? 2 + h1 * 4 : 4 + h1 * 6,
        phaseX1: h2 * Math.PI * 2,
        phaseX2: h3 * Math.PI * 2,
        phaseY1: h1 * Math.PI * 2,
        phaseY2: h4 * Math.PI * 2,
        radius,
        warmth,
        colorR,
        colorG,
        colorB
      });
    }
    this.starSeeds = seeds;
    this._computeChordTimelineMarkers();
  }

  _getAllProjectNotes() {
    const notes = [];
    const tracks = this.rawTracks || (this.project && this.project.tracks) || [];
    for (const tr of tracks) {
      if (tr.notes && Array.isArray(tr.notes)) {
        for (const n of tr.notes) {
          notes.push(n);
        }
      }
    }
    if (notes.length === 0 && this.activeNotes && this.activeNotes.length > 0) {
      return this.activeNotes;
    }
    return notes;
  }

  // detects the chord root and quality at timestamp t from active notes
  _detectChordAt(t, notePool) {
    const active = notePool.filter((n) =>
      (n.time >= t - 0.08 && n.time <= t + 0.35) ||
      (n.time <= t + 0.02 && n.time + n.duration >= t + 0.12)
    );
    if (active.length === 0) return null;

    const sorted = [...active].sort((a, b) => a.midi - b.midi);
    const bassMidi = sorted[0].midi;
    const bassRoot = bassMidi % 12;
    const pitchSet = new Set(active.map((n) => n.midi % 12));

    const keyStr = (this.project.key || '').toLowerCase();
    const isFlatKey = /([a-g]b|bb|eb|ab|db|gb|f\b|d min|g min|c min)/i.test(keyStr);
    const NOTE_NAMES = isFlatKey
      ? ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']
      : ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

    const CHORD_TYPES = [
      { name: 'maj7', intervals: [0, 4, 7, 11], weight: 1.30 },
      { name: 'm7',   intervals: [0, 3, 7, 10], weight: 1.30 },
      { name: '7',    intervals: [0, 4, 7, 10], weight: 1.20 },
      { name: 'maj9', intervals: [0, 4, 7, 11, 2], weight: 1.35 },
      { name: 'add9', intervals: [0, 4, 7, 2],  weight: 1.25 },
      { name: 'maj',  intervals: [0, 4, 7],     weight: 1.15 },
      { name: 'm',    intervals: [0, 3, 7],     weight: 1.15 },
      { name: 'sus4', intervals: [0, 5, 7],     weight: 1.05 },
      { name: 'sus2', intervals: [0, 2, 7],     weight: 1.05 },
      { name: 'dim',  intervals: [0, 3, 6],     weight: 0.90 },
      { name: '5',    intervals: [0, 7],        weight: 0.85 }
    ];

    // evaluate bass root first
    let bestChord = null;
    let bestScore = -999;

    for (const type of CHORD_TYPES) {
      let matched = 0;
      let missed = 0;
      for (const interval of type.intervals) {
        const pitch = (bassRoot + interval) % 12;
        if (pitchSet.has(pitch)) matched++;
        else missed++;
      }
      const score = (matched * 2.5 - missed * 0.8) * type.weight;
      if (matched >= 2 && score > bestScore) {
        bestScore = score;
        const label = type.name === 'maj9' ? 'maj7' : type.name;
        bestChord = NOTE_NAMES[bassRoot] + label;
      }
    }

    if (bestChord && bestScore >= 2.0) {
      return bestChord;
    }

    // fallback: evaluate remaining pitch classes
    for (const root of pitchSet) {
      if (root === bassRoot) continue;
      for (const type of CHORD_TYPES) {
        let matched = 0;
        let missed = 0;
        for (const interval of type.intervals) {
          const pitch = (root + interval) % 12;
          if (pitchSet.has(pitch)) matched++;
          else missed++;
        }
        const score = (matched * 2.0 - missed * 1.0) * type.weight;
        if (matched >= 3 && score > bestScore) {
          bestScore = score;
          const label = type.name === 'maj9' ? 'maj7' : type.name;
          bestChord = NOTE_NAMES[root] + label;
        }
      }
    }

    return bestChord || (NOTE_NAMES[bassRoot] + 'maj');
  }

  _computeChordTimelineMarkers() {
    const bpm = this.project.bpm || 120;
    const dropTime = this.getDropTime();
    const duration = this.project.duration || 29.09;
    const notePool = this._getAllProjectNotes();
    if (notePool.length === 0) {
      this.chordTimelineMarkers = [];
      return;
    }

    const rawTimes = [];
    const cuts = this.project.chordCutTimes || [];
    if (cuts.length >= 2) {
      for (const c of cuts) {
        rawTimes.push(c);
        let introT = c - dropTime;
        while (introT >= -0.05) {
          rawTimes.push(Math.max(0, Number(introT.toFixed(3))));
          introT -= dropTime;
        }
      }
      rawTimes.push(0);
    } else {
      rawTimes.push(0);
      const lowNotes = notePool.filter((n) => n.midi < 55);
      const minInterval = (60 / bpm) * 2.5;
      let lastLowT = -999;
      for (const n of lowNotes) {
        if (n.time - lastLowT >= minInterval) {
          rawTimes.push(Number(n.time.toFixed(3)));
          lastLowT = n.time;
        }
      }
    }

    rawTimes.sort((a, b) => a - b);
    const mergedTimes = [];
    for (const t of rawTimes) {
      if (t < 0 || t > duration - 0.25) continue;
      const hasExisting = mergedTimes.some((m) => Math.abs(m - t) < 0.35);
      if (!hasExisting) {
        mergedTimes.push(t);
      }
    }
    mergedTimes.sort((a, b) => a - b);

    const markers = [];
    let lastChord = null;
    let lastTime = -999;

    for (const t of mergedTimes) {
      const chordName = this._detectChordAt(t, notePool);
      if (!chordName) continue;
      if (chordName === lastChord && (t - lastTime) < 1.3) continue;
      markers.push({ time: t, name: chordName });
      lastChord = chordName;
      lastTime = t;
    }

    this.chordTimelineMarkers = markers;
  }

_getAudioEnergyAt(t) {
  const peaks = this.project.peaks;
  if (!peaks || peaks.length === 0 || !this.project.duration) return 0.35;
  const pos = Math.max(0, Math.min(0.999, t / this.project.duration)) * peaks.length;
  const i0 = Math.floor(pos);
  const i1 = Math.min(peaks.length - 1, i0 + 1);
  const frac = pos - i0;
  return peaks[i0] * (1 - frac) + peaks[i1] * frac;
}

_getStarState(seed, t, driftMult) {
  const age = t - seed.note.time;
  if (age < 0) return null;

  const dAge = age * driftMult;
  const dropTime = this.getDropTime();
  const isPreDropNote = seed.note.time < dropTime;

  let preDropLiftY = 0;
  let preDropAlpha = 1;
  let streakStretch = 1;
  let isLifting = false;

  if (isPreDropNote) {
    if (t >= dropTime) {
      return null;
    }
    const liftInfo = this._getPreDropLift(t);
    if (liftInfo.isLifting) {
      isLifting = true;
      const { pLift, liftEase } = liftInfo;
      preDropLiftY = -liftEase * (this.height * 1.35 + 280);
      streakStretch = 1.0 + liftEase * 5.2;
      preDropAlpha = Math.max(0, 1 - Math.pow(pLift, 4.2));
    }
  }

  // top-left to bottom-right celestial stream
  const bandDriftX = dAge * 15.0;
  const bandDriftY = dAge * 9.5;

  let arcX = 0;
  let arcY = 0;

  if (seed.defiesGravity) {
    arcX = seed.vx0 * dAge + bandDriftX;
    arcY = seed.vy0 * dAge + bandDriftY;
  } else {
    const dAgeClamped = Math.min(12, dAge);
    arcX = (seed.arcDir * (seed.vx0 * dAgeClamped + 0.5 * seed.ax * dAgeClamped * dAgeClamped) * 0.65) + bandDriftX;
    arcY = (seed.vy0 * dAgeClamped + 0.5 * seed.ay * dAgeClamped * dAgeClamped) + bandDriftY;
  }

  const wanderX =
    Math.sin(dAge * seed.freq1 + seed.phaseX1) * seed.amp1 +
    Math.sin(dAge * seed.freq2 + seed.phaseX2) * seed.amp2;
  const wanderY =
    Math.cos(dAge * seed.freq1 * 0.8 + seed.phaseY1) * (seed.amp1 * 0.32);

  const x = seed.x0 + arcX + wanderX;
  const y = seed.y0 + arcY + wanderY + preDropLiftY;

  const margin = 120;
  if (
    x < -margin ||
    x > this.width + margin ||
    y < this.skyTop - margin - 350 ||
    y > this.height + margin
  ) {
    return null;
  }

  let edgeAlpha = 1;
  if (x < 70) edgeAlpha = Math.min(edgeAlpha, Math.max(0, (x + margin) / 170));
  if (x > this.width - 70)
    edgeAlpha = Math.min(edgeAlpha, Math.max(0, (this.width + margin - x) / 170));
  if (y < 60 && !isLifting)
    edgeAlpha = Math.min(edgeAlpha, Math.max(0, y / 60));
  if (y > this.height - 70)
    edgeAlpha = Math.min(edgeAlpha, Math.max(0, (this.height + margin - y) / 170));

  const birthDuration = 0.08;
  const birthEase = Math.min(1, Math.max(0, age / birthDuration));

  const flareDuration = seed.tier === 'high' ? 0.38 : 0.22;
  const flare = age < flareDuration ? Math.pow(1 - age / flareDuration, 2) : 0;

  let timeFade = 1;
  if (seed.tier === 'high') {
    timeFade = Math.max(0, 1 - age / 1.65);
  } else {
    timeFade = Math.max(0, 1 - age / (18 / Math.max(0.35, driftMult)));
  }

  const alpha = Math.min(1, edgeAlpha * timeFade * birthEase * preDropAlpha);
  if (alpha <= 0.012) return null;

  return {
    seed,
    age,
    x,
    y,
    alpha,
    flare,
    streakStretch,
    isLifting
  };
}

_getEffectiveTimeOfDay(t) {
  const tCurrent = t !== undefined ? t : (this._tCurrent !== undefined ? this._tCurrent : 0);
  const baseTod = this.params.timeOfDay !== undefined ? this.params.timeOfDay : 25;
  if (!this.params.sunsetDropTransition) {
    return baseTod;
  }

  const dur = this.project?.duration || 30.0;
  const dropTime = this.getDropTime();
  const isPostDrop = tCurrent >= dropTime;
  const sunsetTarget = 40; // moody dusk without tinting the clip orange

  if (isPostDrop) {
    const loopFade = this._getLoopFade(tCurrent);
    return baseTod + (sunsetTarget - baseTod) * loopFade;
  }

  const { isLifting, liftEase } = this._getPreDropLift(tCurrent);
  if (isLifting) {
    return baseTod + (sunsetTarget - baseTod) * liftEase;
  }

  return baseTod;
}

_getDayInvertFactor(t) {
  const tod = this._getEffectiveTimeOfDay(t);
  if (tod <= 35) return 0;
  const p = Math.min(1, Math.max(0, (tod - 35) / 65));
  return p * p * (3 - 2 * p);
}

_mixRgb(r1, g1, b1, r2, g2, b2, f) {
  const factor = Math.min(1, Math.max(0, f));
  const r = Math.round(r1 + (r2 - r1) * factor);
  const g = Math.round(g1 + (g2 - g1) * factor);
  const b = Math.round(b1 + (b2 - b1) * factor);
  return `rgb(${r}, ${g}, ${b})`;
}

_mixRgba(r1, g1, b1, a1, r2, g2, b2, a2, f) {
  const factor = Math.min(1, Math.max(0, f));
  const r = Math.round(r1 + (r2 - r1) * factor);
  const g = Math.round(g1 + (g2 - g1) * factor);
  const b = Math.round(b1 + (b2 - b1) * factor);
  const a = +(a1 + (a2 - a1) * factor).toFixed(3);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

_getSkyGradientColors(postDropBlend, t) {
  const tod = this._getEffectiveTimeOfDay(t);

  // 4 sky keyframes: deep night (0), midnight (25), dusk (60), daylight (100)
  const k0 = {
    top: [2 + postDropBlend * 1, 3 + postDropBlend * 1, 6 + postDropBlend * 3],
    mid: [4 + postDropBlend * 2, 6 + postDropBlend * 3, 12 + postDropBlend * 6],
    bot: [8 + postDropBlend * 3, 10 + postDropBlend * 3, 20 + postDropBlend * 6],
    horizon: [5 + postDropBlend * 2, 6 + postDropBlend * 2, 14 + postDropBlend * 4]
  };

  const k1 = {
    top: [4 + postDropBlend * 2, 5 + postDropBlend * 3, 10 + postDropBlend * 9],
    mid: [7 + postDropBlend * 5, 10 + postDropBlend * 8, 20 + postDropBlend * 20],
    bot: [12 + postDropBlend * 8, 16 + postDropBlend * 8, 32 + postDropBlend * 16],
    horizon: [8 + postDropBlend * 4, 10 + postDropBlend * 5, 22 + postDropBlend * 10]
  };

  const k2 = {
    top: [24 + postDropBlend * 4, 18 + postDropBlend * 2, 48 + postDropBlend * 8],
    mid: [92 + postDropBlend * 16, 38 + postDropBlend * 8, 76 + postDropBlend * 12],
    bot: [185 + postDropBlend * 25, 88 + postDropBlend * 12, 55 + postDropBlend * 8],
    horizon: [65 + postDropBlend * 8, 35 + postDropBlend * 6, 55 + postDropBlend * 8]
  };

  const k3 = {
    top: [122 + postDropBlend * 4, 138 + postDropBlend * 4, 228 + postDropBlend * 4],
    mid: [175 + postDropBlend * 6, 128 + postDropBlend * 6, 168 + postDropBlend * 4],
    bot: [246 + postDropBlend * 4, 145 + postDropBlend * 4, 88 + postDropBlend * 3],
    horizon: [98 + postDropBlend * 3, 74 + postDropBlend * 3, 112 + postDropBlend * 3]
  };

  let fromK, toK, f;
  if (tod <= 25) {
    fromK = k0;
    toK = k1;
    f = tod / 25;
  } else if (tod <= 60) {
    fromK = k1;
    toK = k2;
    f = (tod - 25) / 35;
  } else {
    fromK = k2;
    toK = k3;
    f = (tod - 60) / 40;
  }

  const lerp = (a, b) => Math.round(a + (b - a) * f);
  return {
    top: [lerp(fromK.top[0], toK.top[0]), lerp(fromK.top[1], toK.top[1]), lerp(fromK.top[2], toK.top[2])],
    mid: [lerp(fromK.mid[0], toK.mid[0]), lerp(fromK.mid[1], toK.mid[1]), lerp(fromK.mid[2], toK.mid[2])],
    bot: [lerp(fromK.bot[0], toK.bot[0]), lerp(fromK.bot[1], toK.bot[1]), lerp(fromK.bot[2], toK.bot[2])],
    horizon: [lerp(fromK.horizon[0], toK.horizon[0]), lerp(fromK.horizon[1], toK.horizon[1]), lerp(fromK.horizon[2], toK.horizon[2])]
  };
}

_getInitialCameraState(motionMult) {
  if (motionMult <= 0.01) return { x: 0, y: 0, rot: 0 };
  return {
    x: 0,
    y: 3.72 * motionMult,
    rot: 0
  };
}

renderFrame(tCurrent, activeVideoFrame = null) {
  const ctx = this.ctx;
  this._tCurrent = tCurrent;
  const W = this.width;
  const H = this.height;
  const dropTime = this.getDropTime();
  const isPostDrop = tCurrent >= dropTime;
  const dropAge = isPostDrop ? tCurrent - dropTime : -1;
  const energy = this._getAudioEnergyAt(tCurrent);
  const bloom = this.params.bloomIntensity;

  const { pLift, liftEase, isLifting } = this._getPreDropLift(tCurrent);

  // camera sway, pre-drop tension rumble, and drop impact punch
  const motionMult = this.params.cameraMotion || 1.0;
  let camX = 0;
  let camY = 0;
  let camRot = 0;

  if (motionMult > 0.01) {
    const dropBlend = isPostDrop ? 1.0 : (isLifting ? Math.pow(pLift, 1.8) : 0.0);

    const swayIntroX = Math.sin(tCurrent * 0.20) * 3.2 + Math.sin(tCurrent * 0.44) * 1.2;
    const swayIntroY = Math.cos(tCurrent * 0.16) * 2.6 + Math.cos(tCurrent * 0.38) * 1.0;
    const jitterIntroX = Math.sin(tCurrent * 3.2) * 0.12;
    const jitterIntroY = Math.cos(tCurrent * 3.8) * 0.12;
    const rotIntro = Math.sin(tCurrent * 0.14) * 0.0010;

    const swayDropX = Math.sin(tCurrent * 0.52) * 3.6 + Math.sin(tCurrent * 1.3) * 1.6;
    const swayDropY = Math.cos(tCurrent * 0.46) * 3.0 + Math.cos(tCurrent * 1.15) * 1.4;
    const jitterDropX = (Math.sin(tCurrent * 14.8) + Math.cos(tCurrent * 22.3)) * 0.42;
    const jitterDropY = (Math.cos(tCurrent * 16.4) + Math.sin(tCurrent * 20.8)) * 0.42;
    const rotDrop = Math.sin(tCurrent * 0.35) * 0.0016 + Math.cos(tCurrent * 8.5) * 0.0003;

    const swayX = swayIntroX * (1 - dropBlend) + swayDropX * dropBlend;
    const swayY = swayIntroY * (1 - dropBlend) + swayDropY * dropBlend;
    const jitterX = jitterIntroX * (1 - dropBlend) + jitterDropX * dropBlend;
    const jitterY = jitterIntroY * (1 - dropBlend) + jitterDropY * dropBlend;
    const baseRot = rotIntro * (1 - dropBlend) + rotDrop * dropBlend;

    let tensionX = 0;
    let tensionY = 0;
    let tensionRot = 0;

    if (isLifting) {
      const tension = Math.pow(pLift, 2.8);
      tensionX = (Math.sin(tCurrent * 42) * 2.4 + Math.cos(tCurrent * 68) * 1.6) * tension * 7.0;
      tensionY = -(pLift * 10 + liftEase * 72) + (Math.cos(tCurrent * 46) * 2.8 + Math.sin(tCurrent * 76) * 1.8) * tension * 7.0;
      tensionRot = Math.sin(tCurrent * 32) * 0.0038 * tension;
    }

    let impactX = 0;
    let impactY = 0;
    if (isPostDrop && dropAge >= 0 && dropAge < 0.38) {
      const punch = Math.pow(1 - dropAge / 0.38, 2.2);
      impactX = Math.sin(dropAge * 68) * 8.5 * punch;
      impactY = Math.cos(dropAge * 74) * 7.5 * punch;
    }

    // ease back to the t=0 camera state during loop turnaround
    const cam0 = this._getInitialCameraState(motionMult);
    camX = (swayX + jitterX + tensionX + impactX) * motionMult;
    camY = (swayY + jitterY + tensionY + impactY) * motionMult;
    camRot = ((baseRot + tensionRot) * motionMult);

    const loopInfo = this._getLoopTransitionInfo(tCurrent);
    if (loopInfo.inTransition) {
      const p = loopInfo.progress;
      const easeP = p * p * (3 - 2 * p);
      camX = camX * (1 - easeP) + cam0.x * easeP;
      camY = camY * (1 - easeP) + cam0.y * easeP;
      camRot = camRot * (1 - easeP) + cam0.rot * easeP;
    }
  }

  // sky gradient background
  const loopInfo = this._getLoopTransitionInfo(tCurrent);
  const loopFade = loopInfo.loopFade;
  const postDropBlend = isPostDrop ? loopFade : 0;

  const skyColors = this._getSkyGradientColors(postDropBlend, tCurrent);
  const skyGrad = ctx.createLinearGradient(0, 0, 0, H);
  skyGrad.addColorStop(0, `rgb(${skyColors.top[0]}, ${skyColors.top[1]}, ${skyColors.top[2]})`);
  skyGrad.addColorStop(0.5, `rgb(${skyColors.mid[0]}, ${skyColors.mid[1]}, ${skyColors.mid[2]})`);
  skyGrad.addColorStop(0.8, `rgb(${skyColors.bot[0]}, ${skyColors.bot[1]}, ${skyColors.bot[2]})`);
  skyGrad.addColorStop(1, `rgb(${skyColors.horizon[0]}, ${skyColors.horizon[1]}, ${skyColors.horizon[2]})`);
  ctx.fillStyle = skyGrad;
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  if (motionMult > 0.01) {
    ctx.translate(W * 0.5 + camX, H * 0.5 + camY);
    ctx.rotate(camRot);
    ctx.translate(-W * 0.5, -H * 0.5);
  }

  if (pLift > 0.005) {
    this._drawBackgroundMotionBlurWarp(ctx, tCurrent, pLift, liftEase, bloom);
  }

  this._drawAmbientNightStars(ctx, tCurrent, isPostDrop, energy, loopFade, pLift, liftEase);

  if (pLift > 0.005) {
    this._drawPreDropWarpSparkles(ctx, tCurrent, pLift, liftEase, bloom);
  }

  if (isPostDrop && activeVideoFrame) {
    this._drawAnimeDropLayer(ctx, activeVideoFrame, dropAge, energy, loopFade);
  }

  if (isPostDrop) {
    this._drawNebulaAndStardust(ctx, tCurrent, dropAge, energy, bloom, loopFade);
    this._drawShootingStars(ctx, dropAge, bloom, loopFade);
  }

  this._drawConstellationsAndStars(ctx, tCurrent, isPostDrop, dropAge, energy, bloom, loopFade);

  if (isPostDrop && dropAge >= 0 && dropAge < 2.2) {
    this._drawDropExplosionFlash(ctx, dropAge, bloom);
  }

  if (isPostDrop && dropAge >= 0.2) {
    const cutInfo = this._getRecentCutInfo(tCurrent);
    if (cutInfo) {
      this._drawChordCutFlash(ctx, cutInfo, bloom);
    }
  }

  ctx.restore();

  this._drawPianoRoll(ctx, tCurrent, isPostDrop, energy);
  this._drawTrackInfoAbovePianoRoll(ctx, isPostDrop, postDropBlend);
}

detectClipFocalPoint(videoEl) {
  if (!videoEl || videoEl.readyState < 2) return 0.5;
  if (videoEl._focalX !== undefined) return videoEl._focalX;

  if (!this._saliencyCanvas) {
    this._saliencyCanvas = document.createElement('canvas');
    this._saliencyCanvas.width = 160;
    this._saliencyCanvas.height = 90;
    this._saliencyCtx = this._saliencyCanvas.getContext('2d', { willReadFrequently: true });
  }

  const w = 160;
  const h = 90;
  const sCtx = this._saliencyCtx;
  try {
    sCtx.drawImage(videoEl, 0, 0, w, h);
    const img = sCtx.getImageData(0, 0, w, h);
    const d = img.data;
    const colScores = new Float32Array(w);

    for (let y = 0; y < h; y++) {
      const rowStart = y * w * 4;
      for (let x = 0; x < w; x++) {
        const idx = rowStart + x * 4;
        const r = d[idx], g = d[idx + 1], b = d[idx + 2];
        // warm skin tone and high-frequency edge contrast heuristics
        const isSkin = (r > 115 && g > 85 && b > 65 && r > g && g > b && (r - b) > 20 && (r - g) > 10 && (r - g) < 75);
        let edge = 0;
        if (x > 0 && x < w - 1) {
          edge = Math.abs(d[idx + 4] - d[idx - 4]);
        }
        const score = (isSkin ? 8.0 : 0.0) + (edge > 25 ? 1.5 : 0.0);
        colScores[x] += score;
      }
    }

    // find 9:16 aspect window with highest subject density
    const winW = Math.round(h * (9 / 16));
    let bestSum = 0;
    let bestX = Math.round((w - winW) * 0.5);

    for (let x = 0; x <= w - winW; x++) {
      let sum = 0;
      for (let k = 0; k < winW; k++) {
        sum += colScores[x + k];
      }
      if (sum > bestSum) {
        bestSum = sum;
        bestX = x;
      }
    }

    const focalX = Math.max(0.18, Math.min(0.82, (bestX + winW * 0.5) / w));
    if (bestSum > 80) {
      videoEl._focalX = focalX;
    }
    return focalX;
  } catch {
    return 0.5;
  }
}

_drawAnimeDropLayer(ctx, videoEl, dropAge, energy, loopFade = 1.0) {
  const vw = videoEl.videoWidth || videoEl.width || 1280;
  const vh = videoEl.videoHeight || videoEl.height || 720;
  if (!vw || !vh) return;

  ctx.save();

  const dur = this.project?.duration || 30.0;
  const dropTime = this.getDropTime();
  const tCurrent = dropAge + dropTime;

  const hasGlitch = this.params.dropGlitch !== false && dropAge >= 0 && dropAge < 0.20;
  const glitchEnv = hasGlitch ? Math.pow(Math.max(0, 1 - dropAge / 0.20), 2.2) : 0;

  const loopInfo = this._getLoopTransitionInfo(tCurrent);
  const glitchOutDur = Math.min(0.55, (loopInfo.loopWin || 0.85) * 0.65);
  const timeUntilLoop = Math.max(0, dur - tCurrent);
  const hasGlitchOut = this.params.dropGlitch !== false && timeUntilLoop < glitchOutDur && loopInfo.inTransition;
  const glitchOutProgress = hasGlitchOut ? Math.max(0, Math.min(1.0, 1.0 - timeUntilLoop / glitchOutDur)) : 0;
  const glitchOutEnv = hasGlitchOut
    ? (glitchOutProgress < 0.45
        ? Math.pow(glitchOutProgress / 0.45, 1.2)
        : Math.pow(Math.max(0, 1.0 - (glitchOutProgress - 0.45) / 0.55), 1.6))
    : 0;

  const revealFactor = hasGlitch
    ? Math.min(1, 0.62 + (1 - glitchEnv) * 0.38 + dropAge * 1.2)
    : Math.min(1, 0.35 + dropAge * 1.4);

  const effectiveFade = loopInfo.clipFade;
  const targetAlpha = this.params.animeOpacity * revealFactor * (0.88 + energy * 0.16) * effectiveFade;
  if (targetAlpha <= 0.005) {
    ctx.restore();
    return;
  }
  ctx.globalAlpha = Math.max(0, Math.min(0.95, targetAlpha));

  const ramp = this.getSpeedRampInfo(tCurrent);
  const rampZoom = ramp.isRamping ? ramp.rampFactor * 0.045 : 0;

  const glitchPunch = (hasGlitch && dropAge < 0.08 ? 0.015 * Math.pow(1 - dropAge / 0.08, 2.0) : 0)
    + (hasGlitchOut ? 0.018 * Math.pow(glitchOutProgress, 2.0) : 0);
  const zoom = 1.02 + Math.sin(dropAge * 0.22) * 0.02 + rampZoom;
  const scale = Math.max(this.width / vw, this.height / vh) * zoom;
  const drawW = vw * scale * (1 + glitchPunch);
  const drawH = vh * scale;

  let targetFocalX = 0.5;
  if (this.params.autoFrame !== false) {
    if (videoEl.dataset && videoEl.dataset.manualFocalX) {
      targetFocalX = parseFloat(videoEl.dataset.manualFocalX) || 0.5;
    } else {
      targetFocalX = this.detectClipFocalPoint(videoEl);
    }
  }
  videoEl._curFocalX = videoEl._curFocalX === undefined
    ? targetFocalX
    : videoEl._curFocalX + (targetFocalX - videoEl._curFocalX) * 0.15;

  const focalX = videoEl._curFocalX;
  const drawX = Math.max(
    this.width - drawW,
    Math.min(0, this.width * 0.5 - focalX * drawW)
  );
  const drawY = (this.height - drawH) * 0.5;

  ctx.drawImage(videoEl, drawX, drawY, drawW, drawH);

  if (hasGlitch && glitchEnv > 0.005) {
    this._drawDropGlitchIn(ctx, videoEl, dropAge, glitchEnv, drawX, drawY, drawW, drawH, vw, vh);
  }

  if (hasGlitchOut && glitchOutEnv > 0.005) {
    this._drawDropGlitchOut(ctx, videoEl, glitchOutProgress, glitchOutEnv, drawX, drawY, drawW, drawH, vw, vh);
  }

  if (ramp.isRamping && ramp.rampFactor > 0.25) {
    this._drawSpeedRampWhipLines(ctx, ramp.rampFactor, this.params.bloomIntensity);
  }

  ctx.globalAlpha = 1;
  const vigTop = ctx.createLinearGradient(0, 0, 0, 90);
  vigTop.addColorStop(0, 'rgba(5, 7, 13, 0.42)');
  vigTop.addColorStop(1, 'rgba(5, 7, 13, 0)');
  ctx.fillStyle = vigTop;
  ctx.fillRect(0, 0, this.width, 90);

  ctx.fillStyle = 'rgba(10, 16, 32, 0.16)';
  ctx.fillRect(0, 0, this.width, this.height);

  ctx.restore();
}

_drawDropGlitchIn(ctx, videoEl, dropAge, glitchEnv, drawX, drawY, drawW, drawH, vw, vh) {
  if (glitchEnv <= 0.005) return;

  const glitchStep = Math.floor(dropAge * 45);

  if (dropAge < 0.09) {
    const rgbEnv = Math.pow(1 - dropAge / 0.09, 1.8);
    const shiftX = (4.5 + this._hash(glitchStep * 7.1) * 3.5) * rgbEnv;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = 0.22 * rgbEnv;
    ctx.drawImage(videoEl, drawX + shiftX, drawY, drawW, drawH);
    ctx.drawImage(videoEl, drawX - shiftX, drawY, drawW, drawH);
    ctx.restore();
  }

  const sliceCount = 4;
  for (let i = 0; i < sliceCount; i++) {
    const seed = glitchStep * 23.3 + i * 17.1;
    const normY = ((this._hash(seed + 0.3) * 0.75) + i * 0.2 + 0.04) % 0.86;
    const normH = 0.025 + this._hash(seed + 1.9) * 0.065;
    const dir = (i % 2 === 0) ? 1 : -1;
    const jitterX = dir * (5 + this._hash(seed + 3.7) * 14) * glitchEnv;

    const sy = normY * vh;
    const sh = Math.min(normH * vh, vh - sy);
    const dy = drawY + normY * drawH;
    const dh = normH * drawH;

    ctx.drawImage(videoEl, 0, sy, vw, sh, drawX + jitterX, dy, drawW, dh);

    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const fringeAlpha = (0.24 * glitchEnv).toFixed(3);
    ctx.fillStyle = `rgba(0, 240, 255, ${fringeAlpha})`;
    ctx.fillRect(drawX + jitterX - 2, dy, 5, dh);
    ctx.fillStyle = `rgba(255, 45, 120, ${fringeAlpha})`;
    ctx.fillRect(drawX + jitterX + drawW - 3, dy, 5, dh);
    ctx.restore();
  }

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const scanSeed = glitchStep * 41.3;
  const y1 = drawY + ((this._hash(scanSeed) * 0.88 + 0.06) % 0.94) * drawH;
  const y2 = drawY + ((this._hash(scanSeed + 8.9) * 0.85 + 0.08) % 0.92) * drawH;

  ctx.fillStyle = `rgba(200, 245, 255, ${(0.38 * glitchEnv).toFixed(3)})`;
  ctx.fillRect(0, y1, this.width, 1.8);

  ctx.fillStyle = `rgba(225, 185, 255, ${(0.28 * glitchEnv).toFixed(3)})`;
  ctx.fillRect(0, y2, this.width, 2.2);

  if (dropAge < 0.12) {
    const bandY = drawY + (this._hash(scanSeed + 14.5) * 0.7 + 0.15) * drawH;
    const bandH = 8 + this._hash(scanSeed + 22.1) * 24;
    ctx.fillStyle = `rgba(255, 255, 255, ${(0.09 * glitchEnv).toFixed(3)})`;
    ctx.fillRect(0, bandY, this.width, bandH);
  }
  ctx.restore();
}

_drawDropGlitchOut(ctx, videoEl, glitchProgress, glitchEnv, drawX, drawY, drawW, drawH, vw, vh) {
  if (glitchEnv <= 0.005) return;

  const glitchStep = Math.floor(glitchProgress * 45);

  const rgbEnv = Math.pow(glitchProgress, 1.2);
  const shiftX = (6.0 + this._hash(glitchStep * 9.3) * 6.0) * rgbEnv;
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.globalAlpha = 0.32 * rgbEnv;
  ctx.drawImage(videoEl, drawX + shiftX, drawY, drawW, drawH);
  ctx.drawImage(videoEl, drawX - shiftX, drawY, drawW, drawH);
  ctx.restore();

  const sliceCount = 5;
  for (let i = 0; i < sliceCount; i++) {
    const seed = glitchStep * 29.7 + i * 19.3;
    const normY = ((this._hash(seed + 0.5) * 0.78) + i * 0.18 + 0.02) % 0.88;
    const normH = 0.03 + this._hash(seed + 2.1) * 0.08;
    const dir = (i % 2 === 0) ? 1 : -1;
    const jitterX = dir * (8 + this._hash(seed + 4.1) * 18) * glitchEnv;

    const sy = normY * vh;
    const sh = Math.min(normH * vh, vh - sy);
    const dy = drawY + normY * drawH;
    const dh = normH * drawH;

    ctx.drawImage(videoEl, 0, sy, vw, sh, drawX + jitterX, dy, drawW, dh);

    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const fringeAlpha = (0.32 * glitchEnv).toFixed(3);
    ctx.fillStyle = `rgba(0, 240, 255, ${fringeAlpha})`;
    ctx.fillRect(drawX + jitterX - 3, dy, 6, dh);
    ctx.fillStyle = `rgba(255, 45, 120, ${fringeAlpha})`;
    ctx.fillRect(drawX + jitterX + drawW - 3, dy, 6, dh);
    ctx.restore();
  }

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const scanSeed = glitchStep * 37.1;
  const y1 = drawY + ((this._hash(scanSeed) * 0.88 + 0.06) % 0.94) * drawH;
  const y2 = drawY + ((this._hash(scanSeed + 9.7) * 0.85 + 0.08) % 0.92) * drawH;

  ctx.fillStyle = `rgba(200, 245, 255, ${(0.42 * glitchEnv).toFixed(3)})`;
  ctx.fillRect(0, y1, this.width, 2.0);

  ctx.fillStyle = `rgba(225, 185, 255, ${(0.32 * glitchEnv).toFixed(3)})`;
  ctx.fillRect(0, y2, this.width, 2.5);

  if (glitchProgress > 0.25 && glitchProgress < 0.85) {
    const bandPhase = Math.sin(((glitchProgress - 0.25) / 0.60) * Math.PI);
    const bandY = drawY + (this._hash(scanSeed + 17.3) * 0.68 + 0.16) * drawH;
    const bandH = 10 + this._hash(scanSeed + 25.1) * 28;
    ctx.fillStyle = `rgba(255, 255, 255, ${(0.14 * bandPhase * glitchEnv).toFixed(3)})`;
    ctx.fillRect(0, bandY, this.width, bandH);
  }
  ctx.restore();
}

_drawSpeedRampWhipLines(ctx, rampFactor, bloom) {
  if (rampFactor < 0.25) return;
  ctx.save();
  const W = this.width;
  const H = this.height;
  const count = 12;
  const whipAlpha = (rampFactor - 0.25) * 0.42 * (0.8 + bloom * 0.35);

  for (let i = 0; i < count; i++) {
    const y = this.skyTop + 40 + this._hash(i * 19.3 + 2.7) * (H - this.skyTop - 250);
    const lineW = 160 + this._hash(i * 7.7) * 420 * rampFactor;
    const x = this._hash(i * 13.1) * (W - lineW);

    const grad = ctx.createLinearGradient(x, y, x + lineW, y);
    grad.addColorStop(0, 'rgba(230, 240, 255, 0)');
    grad.addColorStop(0.5, `rgba(240, 245, 255, ${whipAlpha.toFixed(3)})`);
    grad.addColorStop(1, 'rgba(230, 240, 255, 0)');

    ctx.strokeStyle = grad;
    ctx.lineWidth = 1.0 + this._hash(i * 3.9) * 1.6;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + lineW, y);
    ctx.stroke();
  }
  ctx.restore();
}

_getCutIntervalForTime(t) {
  const dur = this.project?.duration || 30.0;
  const dropTime = (typeof this.project?.dropTime === 'number' && !isNaN(this.project.dropTime))
    ? this.project.dropTime
    : (dur * 0.5);
  const cutMode = this.params.cutMode || 'chord';

  if (cutMode === 'single') {
    return { start: dropTime, end: dur };
  }

  let cuts = [];
  if (cutMode === 'chord') {
    cuts = [dropTime, ...(this.project.chordCutTimes || []).filter((c) => c > dropTime + 0.1), dur];
  } else if (cutMode === 'impact') {
    cuts = [dropTime, ...(this.project.impactTimes || []).filter((c) => c > dropTime + 0.1), dur];
  } else {
    const secPerBar = (60 / (this.project.bpm || 120)) * 4;
    const barCount = cutMode === '2bar' ? 2 : 4;
    const step = secPerBar * barCount;
    for (let ct = dropTime; ct < dur; ct += step) cuts.push(ct);
    cuts.push(dur);
  }
  cuts = Array.from(new Set(cuts)).sort((a, b) => a - b);

  for (let i = 0; i < cuts.length - 1; i++) {
    if (t >= cuts[i] && t < cuts[i + 1]) {
      return { start: cuts[i], end: cuts[i + 1] };
    }
  }
  return { start: cuts[Math.max(0, cuts.length - 2)] || dropTime, end: dur };
}

getSpeedRampInfo(t) {
  if (!this.params.speedRamping) {
    return { clipTime: 0, instSpeed: 1.0, rampFactor: 0, isRamping: false, phase: 'cruise' };
  }
  const dur = this.project?.duration || 30.0;
  const dropTime = (typeof this.project?.dropTime === 'number' && !isNaN(this.project.dropTime))
    ? this.project.dropTime
    : (dur * 0.5);
  if (t < dropTime) {
    return { clipTime: 0, instSpeed: 1.0, rampFactor: 0, isRamping: false, phase: 'pre-drop' };
  }

  const interval = this._getCutIntervalForTime(t);
  const elapsed = Math.max(0, t - interval.start);
  const D = Math.max(0.5, interval.end - interval.start);

  const rampDur = Math.min(0.72, D * 0.40);
  const Sbase = 0.48;
  const Smax = 2.85;
  const Sdiff = Smax - Sbase;

  // composite easing curve: slow middle cruise (0.48x), fast whip into/out of cuts (2.85x)
  const c1 = 0.28;
  const c2 = 0.72;
  const areaCoeff = c1 / 3 + c2 / 5;
  const entryArea = Sbase * rampDur + Sdiff * rampDur * areaCoeff;

  if (elapsed <= rampDur) {
    const p = (rampDur - elapsed) / rampDur;
    const ease = c1 * Math.pow(p, 2) + c2 * Math.pow(p, 4);
    const instSpeed = Sbase + Sdiff * ease;

    const w = rampDur - elapsed;
    const term = Sbase * w + Sdiff * ((c1 * Math.pow(w, 3)) / (3 * rampDur * rampDur) + (c2 * Math.pow(w, 5)) / (5 * Math.pow(rampDur, 4)));
    const clipTime = entryArea - term;

    return { clipTime, instSpeed, rampFactor: ease, isRamping: true, phase: 'in' };
  } else if (elapsed <= D - rampDur) {
    const clipTime = entryArea + Sbase * (elapsed - rampDur);
    return { clipTime, instSpeed: Sbase, rampFactor: 0, isRamping: false, phase: 'cruise' };
  } else {
    const u = elapsed - (D - rampDur);
    const p = u / rampDur;
    const ease = c1 * Math.pow(p, 2) + c2 * Math.pow(p, 4);
    const instSpeed = Sbase + Sdiff * ease;

    const midArea = entryArea + Sbase * (D - 2 * rampDur);
    const exitIntegral = Sbase * u + Sdiff * ((c1 * Math.pow(u, 3)) / (3 * rampDur * rampDur) + (c2 * Math.pow(u, 5)) / (5 * Math.pow(rampDur, 4)));
    const clipTime = midArea + exitIntegral;

    return { clipTime, instSpeed, rampFactor: ease, isRamping: true, phase: 'out' };
  }
}

_drawBackgroundMotionBlurWarp(ctx, t, pLift, liftEase, bloom) {
  if (liftEase <= 0.005) return;
  ctx.save();
  const H = this.height;
  const dropTime = this.getDropTime();
  const preDropDur = this.params?.preDropDuration || 2.2;
  const dt = Math.max(0, t - (dropTime - preDropDur));
  const warpStreakLen = Math.min(540, 24 + liftEase * 440 + Math.pow(pLift, 2.5) * 80);

  for (const line of this.bgWarpLines) {
    const dist = line.speed * dt * 0.4 + liftEase * (H * 1.4);
    const curY = ((line.y0 - dist) % H + H) % H;

    const alpha = line.baseAlpha * liftEase * (0.85 + 0.15 * Math.sin(t * 14 + line.phase)) * (0.75 + bloom * 0.35);
    if (alpha <= 0.005) continue;

    const r = Math.round(180 + line.warmth * 65);
    const g = Math.round(200 + line.warmth * 45);
    const b = Math.round(255 - line.warmth * 30);

    const grad = ctx.createLinearGradient(line.x, curY, line.x, curY + warpStreakLen);
    grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`);
    grad.addColorStop(0.35, `rgba(${r}, ${g}, ${b}, ${(alpha * 0.45).toFixed(3)})`);
    grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);

    ctx.strokeStyle = grad;
    ctx.lineWidth = line.width;
    ctx.beginPath();
    ctx.moveTo(line.x, curY);
    ctx.lineTo(line.x, curY + warpStreakLen);
    ctx.stroke();
  }
  ctx.restore();
}

_drawAmbientNightStars(ctx, t, isPostDrop, energy, loopFade = 1.0, pLift = 0, liftEase = 0) {
  ctx.save();
  const H = this.height;
  const isLifting = liftEase > 0.002 || pLift > 0.01;
  const liftDist = isLifting ? (pLift * 36 + liftEase * (H * 1.35)) : 0;
  const streakLen = isLifting ? Math.min(240, liftEase * 220 + Math.pow(pLift, 3.2) * 50) : 0;

  const dayInvert = this._getDayInvertFactor(t);
  const dayAtten = Math.max(0.65, 1 - dayInvert * 0.35);

  for (const s of this.bgStars) {
    const twinkle = 0.35 + 0.65 * Math.sin(t * s.speed + s.phase);
    const dropBoost = isPostDrop ? (0.10 + energy * 0.3) * loopFade : 0;
    const liftAlphaBoost = isLifting ? liftEase * 0.35 : 0;
    const alpha = twinkle * (0.45 + dropBoost + liftAlphaBoost) * dayAtten;
    const r0 = Math.round(230 + s.warmth * 25);
    const g0 = Math.round(225 + s.warmth * 20);
    const b0 = Math.round(245 - s.warmth * 60);

    const r = Math.round(r0 * (1 - dayInvert) + 32 * dayInvert);
    const g = Math.round(g0 * (1 - dayInvert) + 60 * dayInvert);
    const b = Math.round(b0 * (1 - dayInvert) + 110 * dayInvert);

    const starY = isLifting
      ? (((s.y - liftDist) % H + H) % H)
      : s.y;

    if (isLifting && streakLen > 2.0) {
      const streakGrad = ctx.createLinearGradient(s.x, starY, s.x, starY + streakLen);
      streakGrad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${Math.min(1, alpha * 0.95).toFixed(3)})`);
      streakGrad.addColorStop(0.3, `rgba(${r}, ${g}, ${b}, ${(alpha * 0.45).toFixed(3)})`);
      streakGrad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
      ctx.strokeStyle = streakGrad;
      ctx.lineWidth = Math.max(1.0, s.r * 1.25);
      ctx.beginPath();
      ctx.moveTo(s.x, starY);
      ctx.lineTo(s.x, starY + streakLen);
      ctx.stroke();
    }

    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${Math.min(1, alpha).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(s.x, starY, s.r * (1 + liftEase * 0.35), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

_drawPreDropWarpSparkles(ctx, t, pLift, liftEase, bloom) {
  if (pLift <= 0.005) return;
  ctx.save();
  const H = this.height;
  const dropTime = this.getDropTime();
  const preDropDur = this.params?.preDropDuration || 2.2;
  const dt = Math.max(0, t - (dropTime - preDropDur));
  const inWindowFade = Math.min(1.0, pLift * 2.2);

  for (const sp of this.preDropSparkles) {
    const dist = sp.speed * dt * 0.38 + liftEase * (H * 1.45);
    const curY = ((sp.y0 - dist) % H + H) % H;
    const curX = sp.x0 + Math.sin(t * 3.6 + sp.phase) * (sp.driftX * 0.4 + liftEase * 12);

    const twinkle = 0.4 + 0.6 * Math.sin(t * sp.twinkleSpeed + sp.phase);
    const alpha = inWindowFade * twinkle * Math.min(1.0, 0.38 + liftEase * 0.62);
    if (alpha <= 0.01) continue;

    const streakLen = Math.max(6, 6 + liftEase * 210 + Math.pow(pLift, 3.2) * 40);

    const r0 = Math.round(210 + sp.warmth * 45);
    const g0 = Math.round(225 + sp.warmth * 30);
    const b0 = Math.round(255 - sp.warmth * 55);

    const dayInvert = this._getDayInvertFactor(t);
    const r = Math.round(r0 * (1 - dayInvert) + 32 * dayInvert);
    const g = Math.round(g0 * (1 - dayInvert) + 60 * dayInvert);
    const b = Math.round(b0 * (1 - dayInvert) + 120 * dayInvert);
    const coreR = Math.round(255 * (1 - dayInvert) + 18 * dayInvert);
    const coreG = Math.round(255 * (1 - dayInvert) + 32 * dayInvert);
    const coreB = Math.round(255 * (1 - dayInvert) + 58 * dayInvert);

    const grad = ctx.createLinearGradient(curX, curY, curX, curY + streakLen);
    grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${(alpha * 0.95).toFixed(3)})`);
    grad.addColorStop(0.28, `rgba(${r}, ${g}, ${b}, ${(alpha * 0.45).toFixed(3)})`);
    grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);

    ctx.strokeStyle = grad;
    ctx.lineWidth = Math.max(1.1, sp.size * 1.0);
    ctx.beginPath();
    ctx.moveTo(curX, curY);
    ctx.lineTo(curX, curY + streakLen);
    ctx.stroke();

    const auraR = sp.size * (2.8 + liftEase * 2.4);
    const auraGrad = ctx.createRadialGradient(curX, curY, 0, curX, curY, auraR);
    auraGrad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${(alpha * 0.48).toFixed(3)})`);
    auraGrad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
    ctx.fillStyle = auraGrad;
    ctx.beginPath();
    ctx.arc(curX, curY, auraR, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = `rgba(${coreR}, ${coreG}, ${coreB}, ${Math.min(1.0, alpha * 1.15).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(curX, curY, sp.size * (0.8 + liftEase * 0.4), 0, Math.PI * 2);
    ctx.fill();

    if (sp.size > 2.2 && alpha > 0.45) {
      const glintLen = sp.size * (3.5 + liftEase * 3.0);
      ctx.strokeStyle = `rgba(${coreR}, ${coreG}, ${coreB}, ${(alpha * 0.65).toFixed(3)})`;
      ctx.lineWidth = 0.85;
      ctx.beginPath();
      ctx.moveTo(curX - glintLen, curY);
      ctx.lineTo(curX + glintLen, curY);
      ctx.moveTo(curX, curY - glintLen);
      ctx.lineTo(curX, curY + glintLen);
      ctx.stroke();
    }
  }
  ctx.restore();
}

_drawNebulaAndStardust(ctx, t, dropAge, energy, bloom, loopFade = 1.0) {
  if (loopFade <= 0.005) return;
  ctx.save();

  const nebRadius = (380 + energy * 200) * (0.75 + bloom * 0.5);
  const nebGrad = ctx.createRadialGradient(
    this.skyCenterX,
    this.skyCenterY,
    20,
    this.skyCenterX,
    this.skyCenterY,
    nebRadius
  );
  const nebAlpha = Math.min(0.35, (0.14 + energy * 0.18) * bloom) * loopFade;
  nebGrad.addColorStop(0, `rgba(235, 195, 130, ${(nebAlpha * 0.85).toFixed(3)})`);
  nebGrad.addColorStop(0.45, `rgba(165, 170, 245, ${(nebAlpha * 0.55).toFixed(3)})`);
  nebGrad.addColorStop(1, 'rgba(10, 14, 28, 0)');
  ctx.fillStyle = nebGrad;
  ctx.fillRect(0, 0, this.width, this.height);

  for (const m of this.stardust) {
    const x = ((m.x0 + m.vx * dropAge) % this.width + this.width) % this.width;
    const rawY = m.y0 + m.vy * dropAge;
    const y = ((rawY % this.height) + this.height) % this.height;
    const shimmer = 0.4 + 0.6 * Math.sin(t * 3.2 + m.phase);
    const a = shimmer * 0.58 * bloom * loopFade;

    ctx.fillStyle =
      m.hue === 38
        ? `rgba(255, 230, 170, ${a.toFixed(3)})`
        : `rgba(200, 220, 255, ${a.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(x, y, m.size * (0.8 + energy * 0.5), 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

_drawShootingStars(ctx, dropAge, bloom, loopFade = 1.0) {
  if (dropAge < 0.6 || loopFade <= 0.005) return;

  const baseInterval = 4.5;
  const currentEventIdx = Math.floor(dropAge / baseInterval);

  for (let i = Math.max(0, currentEventIdx - 1); i <= currentEventIdx; i++) {
    const h1 = this._hash(i * 19.7 + 73.1);
    const h2 = this._hash(i * 31.3 + 47.9);
    const h3 = this._hash(i * 53.9 + 11.3);

    const triggerTime = i * baseInterval + 0.6 + h1 * 1.5;
    const duration = 0.85 + h2 * 0.35;
    const progress = (dropAge - triggerTime) / duration;

    if (progress < 0 || progress > 1) continue;

    const alphaEnvelope =
      progress < 0.22
        ? progress / 0.22
        : Math.pow(1 - (progress - 0.22) / 0.78, 1.8);

    const alpha = alphaEnvelope * Math.min(1, 0.78 + bloom * 0.28) * loopFade;
    if (alpha <= 0.01) continue;

    const fromLeft = h3 > 0.35;
    const startX = fromLeft
      ? this.width * (0.05 + h1 * 0.45)
      : this.width * (0.55 + h1 * 0.4);
    const startY = this.skyTop + 40 + h2 * (this.skyHeight * 0.45);

    const angle = fromLeft
      ? 0.42 + h1 * 0.35
      : Math.PI - (0.42 + h1 * 0.35);

    const totalDistance = 500 + h2 * 320;
    const curDist = totalDistance * Math.pow(progress, 0.95);
    const trailLength = Math.min(curDist, (160 + h3 * 140) * (progress < 0.3 ? progress / 0.3 : 1));

    const headX = startX + Math.cos(angle) * curDist;
    const headY = startY + Math.sin(angle) * curDist;
    const tailX = headX - Math.cos(angle) * trailLength;
    const tailY = headY - Math.sin(angle) * trailLength;

    if (headY > this.pianoRollTop + 40 || headX < -50 || headX > this.width + 50) continue;

    ctx.save();

    const trailGrad = ctx.createLinearGradient(headX, headY, tailX, tailY);
    const warmth = h2;
    const r = Math.round(252 + warmth * 3);
    const g = Math.round(232 + warmth * 18);
    const b = Math.round(175 + (1 - warmth) * 75);

    trailGrad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`);
    trailGrad.addColorStop(0.35, `rgba(${r}, ${g - 15}, ${b}, ${(alpha * 0.62).toFixed(3)})`);
    trailGrad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);

    ctx.strokeStyle = trailGrad;
    ctx.lineWidth = 2.4 * (1 - progress * 0.35);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(tailX, tailY);
    ctx.lineTo(headX, headY);
    ctx.stroke();

    ctx.strokeStyle = `rgba(255, 255, 255, ${(alpha * 0.95).toFixed(3)})`;
    ctx.lineWidth = 1.0;
    ctx.beginPath();
    ctx.moveTo(headX - Math.cos(angle) * (trailLength * 0.35), headY - Math.sin(angle) * (trailLength * 0.35));
    ctx.lineTo(headX, headY);
    ctx.stroke();

    const headGlowR = (10 + h1 * 6) * (0.8 + bloom * 0.4);
    const headGrad = ctx.createRadialGradient(headX, headY, 0, headX, headY, headGlowR);
    headGrad.addColorStop(0, `rgba(255, 255, 255, ${alpha.toFixed(3)})`);
    headGrad.addColorStop(0.35, `rgba(${r}, ${g}, ${b}, ${(alpha * 0.6).toFixed(3)})`);
    headGrad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);

    ctx.fillStyle = headGrad;
    ctx.beginPath();
    ctx.arc(headX, headY, headGlowR, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = `rgba(255, 255, 255, ${alpha.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(headX, headY, 1.8, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }
}

_drawConstellationsAndStars(ctx, t, isPostDrop, dropAge, energy, bloom, loopFade = 1.0) {
  const driftMult = this.params.driftSpeed;
  const maxDist = this.params.linkDistance;
  const dayInvert = this._getDayInvertFactor(t);
  const visibleStars = [];

  for (const seed of this.starSeeds) {
    if (seed.note.time > t) break;
    const st = this._getStarState(seed, t, driftMult);
    if (st) visibleStars.push(st);
  }

  ctx.save();
  ctx.lineCap = 'round';

  const postDropDim = isPostDrop ? Math.max(0.36, 1.0 - Math.min(1.0, dropAge * 0.7) * 0.64) : 1.0;
  const postDropFade = isPostDrop ? (postDropDim * loopFade) : 1.0;
  const postDropScale = isPostDrop ? 0.78 : 1.0;

  // constellation link lines
  for (let i = 0; i < visibleStars.length; i++) {
    const a = visibleStars[i];
    if (!a.seed.canLink) continue;
    const isTopA = a.seed.tier === 'high';
    const maxLinksForA = isTopA ? 1 : 3;
    let linksDrawn = 0;

    for (let j = i - 1; j >= 0 && j >= i - 20; j--) {
      const b = visibleStars[j];
      if (!b.seed.canLink) continue;

      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dist = Math.hypot(dx, dy);

      if (dist > 45 && dist < maxDist) {
        const distFactor = 1 - dist / maxDist;
        const hasTopStar = isTopA || b.seed.tier === 'high';
        const pairAlpha =
          Math.min(a.alpha, b.alpha) *
          distFactor *
          postDropFade *
          (isPostDrop ? 0.52 : 0.65) *
          (hasTopStar ? 0.68 : 1.0);

        if (pairAlpha > 0.02) {
          const avgR = Math.round((a.seed.colorR + b.seed.colorR) * 0.5);
          const avgG = Math.round((a.seed.colorG + b.seed.colorG) * 0.5);
          const avgB = Math.round((a.seed.colorB + b.seed.colorB) * 0.5);

          const lineR = Math.round(avgR * (1 - dayInvert) + 38 * dayInvert);
          const lineG = Math.round(avgG * (1 - dayInvert) + 68 * dayInvert);
          const lineB = Math.round(avgB * (1 - dayInvert) + 128 * dayInvert);
          const lineAlpha = (pairAlpha * (1 + 0.35 * dayInvert)).toFixed(3);

          ctx.strokeStyle = `rgba(${lineR}, ${lineG}, ${lineB}, ${lineAlpha})`;
          ctx.lineWidth = (1.1 * distFactor + 0.3) * (hasTopStar ? 0.75 : 1.0);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();

          linksDrawn++;
          if (linksDrawn >= maxLinksForA) break;
        }
      }
    }
  }

  // star nodes and 4-point diffraction spikes
  for (const st of visibleStars) {
    const { seed, x, y, alpha, flare } = st;
    const sR = Math.round(seed.colorR * (1 - dayInvert) + 36 * dayInvert);
    const sG = Math.round(seed.colorG * (1 - dayInvert) + 66 * dayInvert);
    const sB = Math.round(seed.colorB * (1 - dayInvert) + 124 * dayInvert);
    const coreR = Math.round(255 * (1 - dayInvert) + 18 * dayInvert);
    const coreG = Math.round(255 * (1 - dayInvert) + 32 * dayInvert);
    const coreB = Math.round(255 * (1 - dayInvert) + 58 * dayInvert);
    const effAlpha = alpha * postDropFade;

    if (st.isLifting && st.streakStretch > 1.08) {
      const trailH = Math.min(320, (st.streakStretch - 1) * 44);
      const streakGrad = ctx.createLinearGradient(x, y, x, y + trailH);
      streakGrad.addColorStop(0, `rgba(${sR}, ${sG}, ${sB}, ${(effAlpha * 0.95).toFixed(3)})`);
      streakGrad.addColorStop(0.35, `rgba(${sR}, ${Math.max(0, sG - 15)}, ${sB}, ${(effAlpha * 0.45).toFixed(3)})`);
      streakGrad.addColorStop(1, `rgba(${sR}, ${sG}, ${sB}, 0)`);
      ctx.strokeStyle = streakGrad;
      ctx.lineWidth = Math.max(1.2, seed.radius * 0.85);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + trailH);
      ctx.stroke();
    }

    if (seed.defiesGravity && !st.isLifting) {
      const susR = seed.radius * (2.8 + flare * 1.2);
      ctx.strokeStyle = `rgba(${sR}, ${sG}, ${sB}, ${(effAlpha * 0.28).toFixed(3)})`;
      ctx.lineWidth = 0.75;
      ctx.beginPath();
      ctx.arc(x, y, susR, 0, Math.PI * 2);
      ctx.stroke();
    }

    const baseR = seed.radius * (1.0 + flare * 0.45) * postDropScale;
    const scint = 0.86 + 0.14 * Math.sin(t * 9.5 + seed.idx * 4.3);
    const starAlpha = Math.min(1.0, effAlpha * scint);

    ctx.save();
    ctx.translate(x, y);

    const haloR = baseR * (seed.tier === 'low' ? 6.5 : (seed.tier === 'mid' ? 5.2 : 3.8)) * (0.85 + bloom * 0.45);
    const haloAlpha = starAlpha * (seed.tier === 'low' ? 0.38 : (seed.tier === 'mid' ? 0.30 : 0.22)) * (0.8 + bloom * 0.35);

    if (haloAlpha > 0.01) {
      const haloGrad = ctx.createRadialGradient(0, 0, baseR * 0.3, 0, 0, haloR);
      haloGrad.addColorStop(0, `rgba(${sR}, ${sG}, ${sB}, ${haloAlpha.toFixed(3)})`);
      const midR = Math.min(255, sR + 25);
      const midG = Math.max(0, sG - 15);
      const midB = Math.max(0, sB - 35);
      haloGrad.addColorStop(0.4, `rgba(${midR}, ${midG}, ${midB}, ${(haloAlpha * 0.45).toFixed(3)})`);
      haloGrad.addColorStop(0.75, `rgba(${sR}, ${Math.max(0, sG - 25)}, ${Math.min(255, sB + 15)}, ${(haloAlpha * 0.12).toFixed(3)})`);
      haloGrad.addColorStop(1, `rgba(${sR}, ${sG}, ${sB}, 0)`);

      ctx.fillStyle = haloGrad;
      ctx.beginPath();
      ctx.arc(0, 0, haloR, 0, Math.PI * 2);
      ctx.fill();
    }

    const rayLen = baseR * (seed.tier === 'low' ? (5.8 + flare * 2.8) : (seed.tier === 'mid' ? (4.4 + flare * 2.2) : (2.9 + flare * 1.5))) * (0.85 + bloom * 0.25);
    const rayAlpha = Math.min(1.0, starAlpha * (seed.tier === 'low' ? 0.88 : 0.74) * (1.0 + flare * 0.35));

    if (rayLen > 4 && rayAlpha > 0.02) {
      const drawNeedle = (len, w, a) => {
        const grad = ctx.createLinearGradient(0, 0, len, 0);
        grad.addColorStop(0, `rgba(255, 255, 255, ${a.toFixed(3)})`);
        grad.addColorStop(0.22, `rgba(${sR}, ${sG}, ${sB}, ${(a * 0.75).toFixed(3)})`);
        grad.addColorStop(0.68, `rgba(${sR}, ${Math.max(0, sG - 15)}, ${sB}, ${(a * 0.28).toFixed(3)})`);
        grad.addColorStop(1, `rgba(${sR}, ${sG}, ${sB}, 0)`);

        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(0, -w * 0.5);
        ctx.lineTo(len, 0);
        ctx.lineTo(0, w * 0.5);
        ctx.closePath();
        ctx.fill();
      };

      const needleW = Math.max(1.0, baseR * 0.28);
      const lenH = rayLen * 1.15;
      const lenV = rayLen * 0.92;

      drawNeedle(lenH, needleW, rayAlpha);
      ctx.save(); ctx.rotate(Math.PI); drawNeedle(lenH, needleW, rayAlpha); ctx.restore();
      ctx.save(); ctx.rotate(Math.PI * 0.5); drawNeedle(lenV, needleW, rayAlpha); ctx.restore();
      ctx.save(); ctx.rotate(-Math.PI * 0.5); drawNeedle(lenV, needleW, rayAlpha); ctx.restore();

      if (seed.tier !== 'high' || flare > 0.06) {
        const diagLen = rayLen * 0.38;
        const diagW = needleW * 0.65;
        const diagAlpha = rayAlpha * 0.36;

        for (let di = 0; di < 4; di++) {
          ctx.save();
          ctx.rotate(Math.PI * 0.25 + di * Math.PI * 0.5);
          drawNeedle(diagLen, diagW, diagAlpha);
          ctx.restore();
        }
      }
    }

    const coreRadius = Math.max(1.2, baseR * (seed.tier === 'low' ? 0.65 : (seed.tier === 'mid' ? 0.55 : 0.45)));
    const coreAlpha = Math.min(1.0, starAlpha * (0.95 + flare * 0.35));

    const coreGlow = ctx.createRadialGradient(0, 0, 0, 0, 0, coreRadius * 2.2);
    coreGlow.addColorStop(0, `rgba(255, 255, 255, ${coreAlpha.toFixed(3)})`);
    coreGlow.addColorStop(0.45, `rgba(${sR}, ${sG}, ${sB}, ${(coreAlpha * 0.75).toFixed(3)})`);
    coreGlow.addColorStop(1, `rgba(${sR}, ${sG}, ${sB}, 0)`);
    ctx.fillStyle = coreGlow;
    ctx.beginPath();
    ctx.arc(0, 0, coreRadius * 2.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = `rgba(${coreR}, ${coreG}, ${coreB}, ${coreAlpha.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(0, 0, coreRadius, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  ctx.restore();
}

  _drawDropExplosionFlash(ctx, dropAge, bloom) {
    ctx.save();
    const progress = dropAge / 2.2;
    const flashAlpha = Math.pow(Math.max(0, 1 - dropAge / 0.85), 2.2) * 0.72 * bloom;

    if (flashAlpha > 0.01) {
      const flashGrad = ctx.createRadialGradient(
        this.skyCenterX,
        this.skyCenterY,
        10,
        this.skyCenterX,
        this.skyCenterY,
        980
      );
      flashGrad.addColorStop(0, `rgba(255, 245, 215, ${flashAlpha.toFixed(3)})`);
      flashGrad.addColorStop(0.45, `rgba(225, 200, 255, ${(flashAlpha * 0.65).toFixed(3)})`);
      flashGrad.addColorStop(1, 'rgba(15, 20, 38, 0)');
      ctx.fillStyle = flashGrad;
      ctx.fillRect(0, 0, this.width, this.height);
    }

    const ringRadius = 40 + Math.pow(progress, 0.55) * 920;
    const ringAlpha = Math.pow(1 - progress, 1.8) * 0.55 * bloom;
    if (ringAlpha > 0.01) {
      ctx.strokeStyle = `rgba(255, 235, 190, ${ringAlpha.toFixed(3)})`;
      ctx.lineWidth = 2.5 * (1 - progress * 0.7);
      ctx.beginPath();
      ctx.arc(this.skyCenterX, this.skyCenterY, ringRadius, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  _getRecentCutInfo(tCurrent) {
    const cutMode = this.params.cutMode || 'chord';
    if (cutMode === 'single') return -1;
    const dropTime = this.getDropTime();
    if (tCurrent < dropTime + 0.1) return -1;

    let cuts = [];
    if (cutMode === 'chord') {
      cuts = this.project.chordCutTimes || [];
    } else if (cutMode === 'impact') {
      cuts = this.project.impactTimes || [];
    } else if (cutMode === '2bar' || cutMode === '4bar') {
      const secPerBar = (60 / (this.project.bpm || 120)) * 4;
      const barCount = cutMode === '2bar' ? 2 : 4;
      const step = secPerBar * barCount;
      const dur = this.project.duration || 30;
      for (let t = dropTime; t < dur; t += step) {
        cuts.push(t);
      }
    }

    let minDelta = 999;
    let closestIdx = -1;
    let closestCutTime = -1;
    const window = 0.32;

    for (let i = 0; i < cuts.length; i++) {
      const c = cuts[i];
      const dt = tCurrent - c;
      if (Math.abs(c - dropTime) < 0.15) continue;
      if (dt >= 0 && dt < window && dt < minDelta) {
        minDelta = dt;
        closestIdx = i;
        closestCutTime = c;
      }
    }

    if (closestIdx >= 0 && minDelta < 999) {
      return { dt: minDelta, cutIdx: closestIdx, cutTime: closestCutTime };
    }
    return null;
  }

  _getRecentCutDelta(tCurrent) {
    const info = this._getRecentCutInfo(tCurrent);
    return info ? info.dt : -1;
  }

  _drawChordCutFlash(ctx, cutInfo, bloom) {
    const dt = typeof cutInfo === 'object' ? cutInfo.dt : cutInfo;
    const cutIdx = (typeof cutInfo === 'object' && cutInfo.cutIdx !== undefined) ? cutInfo.cutIdx : 0;
    if (dt < 0 || dt > 0.32) return;
    const loopFade = this._getLoopFade(this._tCurrent);
    if (loopFade <= 0.05) return;

    const progress = dt / 0.32;
    const flareEnv = Math.pow(Math.max(0, 1 - progress), 2.2);
    if (flareEnv <= 0.005) return;

    ctx.save();
    ctx.globalCompositeOperation = 'screen';

    const W = this.width;
    const H = this.height;
    const centerX = this.skyCenterX;
    const centerY = this.skyCenterY;

    const hashA = this._hash(cutIdx * 19.3 + 3.7);
    const hashB = this._hash(cutIdx * 31.7 + 7.1);
    const flareX = W * (0.34 + hashA * 0.32);
    const flareY = this.skyTop + (this.pianoRollTop - this.skyTop) * (0.28 + hashB * 0.24);

    // diffuse optical bloom wash
    const washRadius = 620 * (0.8 + 0.2 * flareEnv);
    const washAlpha = 0.24 * flareEnv * (0.8 + bloom * 0.35);
    const washGrad = ctx.createRadialGradient(flareX, flareY, 15, flareX, flareY, washRadius);
    washGrad.addColorStop(0, `rgba(255, 245, 215, ${washAlpha.toFixed(3)})`);
    washGrad.addColorStop(0.32, `rgba(255, 210, 145, ${(washAlpha * 0.55).toFixed(3)})`);
    washGrad.addColorStop(0.72, `rgba(175, 155, 245, ${(washAlpha * 0.22).toFixed(3)})`);
    washGrad.addColorStop(1, 'rgba(10, 15, 30, 0)');
    ctx.fillStyle = washGrad;
    ctx.fillRect(0, 0, W, H);

    // horizontal anamorphic streak
    const bandH = (32 + 20 * flareEnv) * (0.85 + bloom * 0.25);
    const bandGrad = ctx.createLinearGradient(0, flareY - bandH * 0.5, 0, flareY + bandH * 0.5);
    bandGrad.addColorStop(0, 'rgba(255, 210, 130, 0)');
    bandGrad.addColorStop(0.5, `rgba(255, 235, 195, ${(0.32 * flareEnv).toFixed(3)})`);
    bandGrad.addColorStop(1, 'rgba(255, 210, 130, 0)');
    ctx.fillStyle = bandGrad;
    ctx.fillRect(0, flareY - bandH * 0.5, W, bandH);

    const razorH = Math.max(1.8, 3.2 * flareEnv);
    const razorGrad = ctx.createRadialGradient(flareX, flareY, 0, flareX, flareY, W * 0.54);
    razorGrad.addColorStop(0, `rgba(255, 255, 255, ${(0.96 * flareEnv).toFixed(3)})`);
    razorGrad.addColorStop(0.2, `rgba(220, 245, 255, ${(0.80 * flareEnv).toFixed(3)})`);
    razorGrad.addColorStop(0.55, `rgba(135, 205, 255, ${(0.38 * flareEnv).toFixed(3)})`);
    razorGrad.addColorStop(1, 'rgba(90, 150, 255, 0)');
    ctx.fillStyle = razorGrad;
    ctx.fillRect(0, flareY - razorH * 0.5, W, razorH);

    const fringeAlpha = (0.24 * flareEnv).toFixed(3);
    ctx.fillStyle = `rgba(100, 225, 255, ${fringeAlpha})`;
    ctx.fillRect(0, flareY - razorH * 0.5 - 1.6, W, 1.2);
    ctx.fillStyle = `rgba(255, 140, 85, ${fringeAlpha})`;
    ctx.fillRect(0, flareY + razorH * 0.5 + 0.6, W, 1.2);

    const coreR = (12 + 28 * flareEnv) * (0.85 + bloom * 0.25);
    const coreGrad = ctx.createRadialGradient(flareX, flareY, 0, flareX, flareY, coreR);
    coreGrad.addColorStop(0, `rgba(255, 255, 255, ${(0.95 * flareEnv).toFixed(3)})`);
    coreGrad.addColorStop(0.35, `rgba(255, 248, 215, ${(0.78 * flareEnv).toFixed(3)})`);
    coreGrad.addColorStop(0.75, `rgba(255, 195, 120, ${(0.32 * flareEnv).toFixed(3)})`);
    coreGrad.addColorStop(1, 'rgba(255, 180, 90, 0)');
    ctx.fillStyle = coreGrad;
    ctx.beginPath();
    ctx.arc(flareX, flareY, coreR, 0, Math.PI * 2);
    ctx.fill();

    // optical lens ghosts along the aperture axis
    const axisDx = centerX - flareX;
    const axisDy = centerY - flareY;

    const g1X = flareX + axisDx * 0.55;
    const g1Y = flareY + axisDy * 0.55;
    const g1R = 24 + 14 * flareEnv;
    ctx.strokeStyle = `rgba(255, 215, 130, ${(0.34 * flareEnv).toFixed(3)})`;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(g1X, g1Y, g1R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = `rgba(255, 225, 160, ${(0.07 * flareEnv).toFixed(3)})`;
    ctx.fill();

    const g2X = flareX + axisDx * 1.35;
    const g2Y = flareY + axisDy * 1.35;
    const g2R = 46 + 26 * flareEnv;
    const g2Grad = ctx.createRadialGradient(g2X, g2Y, g2R * 0.5, g2X, g2Y, g2R);
    g2Grad.addColorStop(0, 'rgba(80, 180, 255, 0)');
    g2Grad.addColorStop(0.8, `rgba(100, 205, 255, ${(0.16 * flareEnv).toFixed(3)})`);
    g2Grad.addColorStop(1, 'rgba(80, 180, 255, 0)');
    ctx.fillStyle = g2Grad;
    ctx.beginPath();
    ctx.arc(g2X, g2Y, g2R, 0, Math.PI * 2);
    ctx.fill();

    const g3X = flareX + axisDx * 1.75;
    const g3Y = flareY + axisDy * 1.75;
    const g3R = 6 + 4 * flareEnv;
    ctx.fillStyle = `rgba(215, 165, 255, ${(0.32 * flareEnv).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(g3X, g3Y, g3R, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  _drawPianoRoll(ctx, t, isPostDrop, energy) {
    const top = this.pianoRollTop;
    const W = this.width;
    const playheadX = 250;
    const pxPerSec = 175;
    const dayInvert = this._getDayInvertFactor(t);

    ctx.save();

    ctx.textAlign = 'left';
    ctx.fillStyle = this._mixRgb(237, 240, 248, 20, 26, 36, dayInvert);
    ctx.font = '600 24px "Space Grotesk", sans-serif';
    ctx.fillText('• notes', 48, top + 42);

    const title = (this.project.title || 'untitled').toLowerCase();
    const rawNum = this.project.sampleNumber ? String(this.project.sampleNumber).trim() : '';
    const numFormatted = rawNum ? (rawNum.startsWith('#') ? rawNum : `#${rawNum}`) : '';
    const sampleDisplay = numFormatted ? `${numFormatted} · ${title}` : title;

    ctx.textAlign = 'right';
    ctx.fillStyle = this._mixRgb(237, 240, 248, 20, 26, 36, dayInvert);
    ctx.font = '600 24px "IBM Plex Mono", monospace';
    ctx.fillText(sampleDisplay, W - 48, top + 42);

    ctx.textAlign = 'left';
    const activeTrackNames = this.rawTracks
      .filter((tr) => this.selectedTrackIds.has(tr.id))
      .map((tr) => tr.name.toLowerCase())
      .join(' + ');
    ctx.fillStyle = this._mixRgba(165, 175, 205, 0.75, 50, 62, 85, 0.80, dayInvert);
    ctx.font = '500 16px "IBM Plex Mono", monospace';
    ctx.fillText(`source · ${activeTrackNames || 'midi'}`, 48, top + 72);

    const gridTop = top + 92;
    const gridBottom = this.height - 54;
    const gridHeight = gridBottom - gridTop;
    const gridLeft = 105;

    ctx.strokeStyle = this._mixRgba(255, 255, 255, 0.14, 0, 0, 0, 0.16, dayInvert);
    ctx.lineWidth = 1;
    const numTicks = 26;
    for (let i = 0; i <= numTicks; i++) {
      const ty = gridTop + (i / numTicks) * gridHeight;
      const tickW = i % 4 === 0 ? 20 : 10;
      ctx.beginPath();
      ctx.moveTo(48, ty);
      ctx.lineTo(48 + tickW, ty);
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.rect(gridLeft, gridTop - 28, W - gridLeft - 32, gridHeight + 40);
    ctx.clip();

    ctx.strokeStyle = this._mixRgba(255, 255, 255, 0.04, 0, 0, 0, 0.05, dayInvert);
    for (let i = 0; i <= 8; i++) {
      const gy = gridTop + (i / 8) * gridHeight;
      ctx.beginPath();
      ctx.moveTo(gridLeft, gy);
      ctx.lineTo(W - 32, gy);
      ctx.stroke();
    }

    const secPerBar = (60 / (this.project.bpm || 120)) * 4;
    const dur = this.project.duration || 30.0;
    const totalBars = Math.max(1, Math.round(dur / secPerBar));
    const firstBar = Math.floor((t - 2) / secPerBar);
    const lastBar = Math.ceil((t + 6) / secPerBar);

    ctx.font = '500 16px "IBM Plex Mono", monospace';
    for (let b = firstBar; b <= lastBar; b++) {
      const barTime = b * secPerBar;
      const bx = playheadX + (barTime - t) * pxPerSec;
      if (bx < gridLeft - 20 || bx > W) continue;

      const normBar = ((b % totalBars) + totalBars) % totalBars;
      const displayBarNum = normBar + 1;
      const isDropBarLine = displayBarNum === this.project.dropBar;
      ctx.strokeStyle = isDropBarLine
        ? this._mixRgba(223, 158, 40, 0.45, 165, 100, 10, 0.55, dayInvert)
        : this._mixRgba(255, 255, 255, 0.07, 0, 0, 0, 0.10, dayInvert);
      ctx.lineWidth = isDropBarLine ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(bx, gridTop);
      ctx.lineTo(bx, gridBottom);
      ctx.stroke();

      ctx.fillStyle = isDropBarLine
        ? this._mixRgb(223, 158, 40, 150, 88, 3, dayInvert)
        : this._mixRgba(180, 190, 215, 0.72, 45, 58, 80, 0.82, dayInvert);
      ctx.fillText(String(displayBarNum), bx - 4, gridTop - 12);
    }

    const chordMarkers = this.chordTimelineMarkers || [];
    if (chordMarkers.length > 0) {
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = this._mixRgba(223, 158, 40, 0.45, 165, 100, 10, 0.60, dayInvert);
      ctx.lineWidth = 1.2;
      ctx.font = '600 14px "IBM Plex Mono", monospace';
      ctx.fillStyle = this._mixRgba(238, 178, 55, 0.95, 133, 71, 0, 1.0, dayInvert);
      ctx.textAlign = 'center';

      for (let ci = 0; ci < chordMarkers.length; ci++) {
        const marker = chordMarkers[ci];
        const cx = playheadX + (marker.time - t) * pxPerSec;
        if (cx < gridLeft - 40 || cx > W + 40) continue;
        ctx.beginPath();
        ctx.moveTo(cx, gridTop - 4);
        ctx.lineTo(cx, gridBottom);
        ctx.stroke();

        ctx.fillText('▲ ' + marker.name, cx, gridTop - 14);
      }
      ctx.restore();
    }

    // scrolling midi notes with circular loop wrapping
    const pitchSpan = Math.max(1, this.maxPitch - this.minPitch);

    const drawNoteBar = (n, noteTime, isWrappedIntro) => {
      const nEnd = noteTime + n.duration;
      if (nEnd < t - 1.5 || noteTime > t + 5.5) return;

      const nx = playheadX + (noteTime - t) * pxPerSec;
      const nw = Math.max(8, n.duration * pxPerSec - 2);
      const pitchNorm = (n.midi - this.minPitch) / pitchSpan;
      const ny = gridBottom - pitchNorm * (gridHeight - 16) - 10;
      const nh = 5.5;

      const isPlaying = t >= noteTime && t <= nEnd;
      const hasPassed = t > nEnd;
      const notePostDrop = isWrappedIntro ? false : (noteTime >= this.getDropTime());

      if (isPlaying) {
        ctx.fillStyle = notePostDrop
          ? this._mixRgb(255, 228, 168, 200, 124, 8, dayInvert)
          : this._mixRgb(255, 255, 255, 30, 53, 92, dayInvert);
        ctx.shadowColor = notePostDrop
          ? this._mixRgba(255, 210, 120, 0.9, 200, 120, 10, 0.7, dayInvert)
          : this._mixRgba(170, 210, 255, 0.9, 30, 50, 90, 0.6, dayInvert);
        ctx.shadowBlur = 14;
        ctx.fillRect(nx, ny, nw, nh);
        ctx.shadowBlur = 0;

        const hitAge = t - noteTime;
        const ringR = 5 + Math.min(1, hitAge * 4) * 14;
        ctx.strokeStyle = notePostDrop
          ? this._mixRgba(255, 225, 160, 0.75, 180, 105, 10, 0.85, dayInvert)
          : this._mixRgba(200, 225, 255, 0.75, 30, 55, 100, 0.85, dayInvert);
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(playheadX, ny + nh * 0.5, ringR, 0, Math.PI * 2);
        ctx.stroke();
      } else if (hasPassed) {
        ctx.fillStyle = this._mixRgba(130, 150, 190, 0.32, 55, 75, 110, 0.35, dayInvert);
        ctx.fillRect(nx, ny, nw, nh);
      } else {
        ctx.shadowColor = this._mixRgba(0, 0, 0, 0.55, 255, 255, 255, 0.35, dayInvert);
        ctx.shadowBlur = 4;
        ctx.fillStyle = notePostDrop
          ? this._mixRgba(215, 230, 255, 0.88, 40, 62, 100, 0.88, dayInvert)
          : this._mixRgba(175, 200, 255, 0.82, 32, 50, 85, 0.82, dayInvert);
        ctx.fillRect(nx, ny, nw, nh);
        ctx.shadowBlur = 0;
      }
    };

    for (const n of this.activeNotes) {
      drawNoteBar(n, n.time, false);
      if (this.params.seamlessLoop) {
        if (t > dur - 6.0 && n.time < 6.0) {
          drawNoteBar(n, n.time + dur, true);
        }
        if (t < 2.5 && n.time > dur - 3.0) {
          drawNoteBar(n, n.time - dur, false);
        }
      }
    }

    const loopFade = this._getLoopFade(t);
    const postDropPlayhead = isPostDrop ? loopFade : 0;
    const phGold = [245, 228, 198];
    const phSilver = [224, 231, 250];
    const phR = Math.round(phSilver[0] + (phGold[0] - phSilver[0]) * postDropPlayhead);
    const phG = Math.round(phSilver[1] + (phGold[1] - phSilver[1]) * postDropPlayhead);
    const phB = Math.round(phSilver[2] + (phGold[2] - phSilver[2]) * postDropPlayhead);
    ctx.strokeStyle = this._mixRgb(phR, phG, phB, 20, 29, 46, dayInvert);
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(playheadX, gridTop - 6);
    ctx.lineTo(playheadX, gridBottom + 6);
    ctx.stroke();

    ctx.restore();
  }

  _drawTrackInfoAbovePianoRoll(ctx, isPostDrop, postDropBlend = 0) {
    const W = this.width;
    const bpmVal = parseFloat(this.project.bpm) || 120;
    const bpmStr = bpmVal % 1 === 0 ? String(bpmVal) : bpmVal.toFixed(1);
    const keyStr = (this.project.key || '').toLowerCase();
    const text = keyStr ? `${bpmStr} bpm · ${keyStr}` : `${bpmStr} bpm`;

    const artist = (this.project.brand || 'aesttc').toLowerCase();
    const dayInvert = this._getDayInvertFactor(this._tCurrent);

    ctx.save();
    ctx.textAlign = 'center';

    if (dayInvert > 0.5) {
      const whiteBacklight = +(0.85 * dayInvert).toFixed(2);
      ctx.shadowColor = `rgba(255, 255, 255, ${whiteBacklight})`;
      ctx.shadowBlur = 8;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 1;
    } else {
      if (postDropBlend > 0.05) {
        const auraAlpha = +(0.65 * postDropBlend * (1 - dayInvert)).toFixed(2);
        ctx.shadowColor = `rgba(223, 158, 40, ${auraAlpha})`;
        ctx.shadowBlur = 14 * postDropBlend;
      } else {
        const shadowAlpha = +(0.9 * (1 - dayInvert)).toFixed(2);
        ctx.shadowColor = `rgba(0, 0, 0, ${shadowAlpha})`;
        ctx.shadowBlur = 10;
      }
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 2;
    }

    const baseY = this.pianoRollTop;

    ctx.font = '600 32px "IBM Plex Mono", monospace';
    ctx.fillStyle = this._mixRgb(226, 232, 245, 30, 38, 54, dayInvert);
    ctx.fillText(text, W * 0.5, baseY - 56);

    ctx.font = '500 20px "IBM Plex Mono", monospace';
    ctx.fillStyle = this._mixRgba(165, 178, 205, 0.78, 65, 75, 95, 0.80, dayInvert);
    ctx.fillText(artist, W * 0.5, baseY - 20);

    ctx.restore();
  }
}

window.SampleVisualizer = SampleVisualizer;
