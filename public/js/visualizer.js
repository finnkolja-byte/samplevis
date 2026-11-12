/**
 * SampleVis 9:16 Night-Sky Constellation + Anime Drop + Liquid Glass Piano Roll Visualizer
 * Deterministic frame renderer: given timestamp `t` (seconds), renders identical 1080x1920 frames
 * for both real-time 60fps preview and client-side WebCodecs MP4 export.
 */
class SampleVisualizer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.width = 1080;
    this.height = 1920;

    // Layout geometry (1080x1920) - top bar removed for open sky
    this.headerHeight = 0;
    this.pianoRollTop = 1390;
    this.skyTop = 0;
    this.skyHeight = this.pianoRollTop;
    this.skyCenterX = this.width * 0.5;
    this.skyCenterY = this.skyHeight * 0.48;

    // Tunable parameters
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
      loopTransitionDuration: null, // defaults to 2 musical beats (~0.85s - 1.0s) for natural turnaround
      preDropDuration: 2.2,
      speedRamping: true,
      middleSpawnChance: 0.20,
      topStarLinkChance: 0.22,
      timeOfDay: 25,
      sunsetDropTransition: false,
      dropGlitch: true,
      autoFrame: true
    };

    // Project state (lowercase aesthetic)
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

    // Background ambient stars & celestial stardust
    this.bgStars = this._createBgStars(160);
    this.stardust = this._createStardust(90);
    this.bgWarpLines = this._createBgWarpLines(36);
    this.preDropSparkles = this._createPreDropSparkles(150);
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
      // Quantize speed to integer harmonic of loop frequency so twinkle(duration) == twinkle(0)
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
      // Hermite ease for environment (sky, stars, camera): smooth S-curve settling to 0
      const easeP = p * p * (3 - 2 * p);
      const loopFade = Math.max(0, 1.0 - easeP);
      // Clip fade: completely dissolved by p = 0.70 so final ~250ms is clean starry sky identical to frame 0
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
    const durProj = this.project?.duration || 30.0;
    const dropTime = (typeof this.project?.dropTime === 'number' && !isNaN(this.project.dropTime))
      ? this.project.dropTime
      : (durProj * 0.5);
    const dur = this.params?.preDropDuration || 2.2;
    if (t >= dropTime - dur && t < dropTime) {
      const p = (t - (dropTime - dur)) / dur;
      // Slower subtle float for longer at the start, then explosive rapid acceleration
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
    const dur = this.project?.duration || 30.0;
  const dropTime = (typeof this.project?.dropTime === 'number' && !isNaN(this.project.dropTime))
    ? this.project.dropTime
    : (dur * 0.5);
    const duration = this.project.duration || 29.09;

    for (const track of this.rawTracks) {
      if (!this.selectedTrackIds.has(track.id)) continue;
      const trackNotes = track.notes || [];
      let maxNoteTime = 0;
      for (const n of trackNotes) {
        if (n.time > maxNoteTime) maxNoteTime = n.time;
        notes.push({ ...n, trackId: track.id });
      }

      // If this track only exists in the Intro (before Drop) and loopIntroMidi is checked, mirror it into the Drop
      if (
        this.params.loopIntroMidi &&
        trackNotes.length > 0 &&
        maxNoteTime <= dropTime + 0.15 &&
        dropTime > 2 &&
        duration > dropTime + 2
      ) {
        for (const n of trackNotes) {
          const mirroredTime = n.time + dropTime;
          if (mirroredTime + 0.05 < duration) {
            notes.push({
              ...n,
              time: Number(mirroredTime.toFixed(4)),
              beat: Number((n.beat + (dropTime * this.project.bpm) / 60).toFixed(4)),
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

    // Build organic star trajectories for each note
    // Smooth, premium crystallization + unique warm/yellow bloom shade for each star
    const pitchSpan = Math.max(1, this.maxPitch - this.minPitch);
    const bpm = this.project.bpm || 120;
    const secPerBar = (60 / bpm) * 4;
    const startY = 50; // clean margin from the very top of the canvas
    const endY = this.pianoRollTop - 110; // right above track info & piano roll (~1280px)
    const usableH = endY - startY; // full vertical canvas height (~1230px)

    // Identify the lowest 12 unique pitches so they spawn noticeably larger alpha stars
    const uniquePitches = Array.from(new Set(notes.map((n) => n.midi))).sort((a, b) => a - b);
    const lowest12Set = new Set(uniquePitches.slice(0, 12));

    // Flanking perimeter clusters framing the scene on the left and right across the full height of the sky
    const introClusters = [
      { x: 280, y: startY + usableH * 0.22, tier: 0 }, // West Upper
      { x: 800, y: startY + usableH * 0.26, tier: 0 }, // East Upper
      { x: 260, y: startY + usableH * 0.50, tier: 1 }, // West Mid
      { x: 820, y: startY + usableH * 0.54, tier: 1 }, // East Mid
      { x: 290, y: startY + usableH * 0.78, tier: 2 }, // West Lower (above piano roll)
      { x: 790, y: startY + usableH * 0.84, tier: 2 }  // East Lower (above piano roll)
    ];

    // In drop: flanking perimeter clusters framing the anime scene across the entire screen height
    const dropClusters = [
      { x: 180, y: startY + usableH * 0.16, tier: 0 }, // Far-Left Upper
      { x: 900, y: startY + usableH * 0.16, tier: 0 }, // Far-Right Upper
      { x: 220, y: startY + usableH * 0.42, tier: 1 }, // Far-Left Mid-Upper
      { x: 860, y: startY + usableH * 0.42, tier: 1 }, // Far-Right Mid-Upper
      { x: 200, y: startY + usableH * 0.68, tier: 2 }, // Far-Left Mid-Lower
      { x: 880, y: startY + usableH * 0.68, tier: 2 }, // Far-Right Mid-Lower
      { x: 190, y: startY + usableH * 0.86, tier: 2 }, // Far-Left Floor (above piano roll)
      { x: 890, y: startY + usableH * 0.86, tier: 2 }  // Far-Right Floor (above piano roll)
    ];

    // Central constellation clusters spanning upper, mid, and floor (spawned with smaller probability)
    const middleClusters = [
      { x: 540, y: startY + usableH * 0.18, tier: 0 }, // Center Upper
      { x: 540, y: startY + usableH * 0.48, tier: 1 }, // Center Mid
      { x: 540, y: startY + usableH * 0.76, tier: 2 }  // Center Lower (above piano roll)
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

      const pitchNorm = (n.midi - this.minPitch) / pitchSpan; // 0..1
      const isDropNote = n.time >= dropTime;
      const isMiddleSpawn = hMid < middleChance;

      // Classify into 3 distinct visual tiers:
      // - low: lowest 12 notes (or bottom register) -> large, prominent constellation stars with diffraction spikes
      // - mid: mid notes -> crystalline starlight motes with shimmer rings
      // - high: high notes -> small pinpoint shining dots that fade quickly
      const isLowest12 = lowest12Set.has(n.midi) || (n.midi - this.minPitch <= 12);
      let tier = 'mid';
      if (isLowest12 || pitchNorm < 0.28) {
        tier = 'low'; // bottom / chord / bass notes
      } else if (pitchNorm > 0.68 || /sparkle|bell/i.test(n.track || '')) {
        tier = 'high'; // high / sparkle notes
      }

      // Assign note to a celestial constellation cluster across full height:
      // High register notes bias towards upper clusters, mid to mid, bass/chords to lower sky near piano roll
      let cluster;
      const pitchTier = Math.min(2, Math.floor((1 - pitchNorm) * 2.99)); // 0: high, 1: mid, 2: low

      if (isMiddleSpawn) {
        // Smaller chance: spawn gracefully in the middle column across the full height
        const matchingMid = middleClusters.filter((c) => c.tier === pitchTier);
        cluster = matchingMid.length > 0 ? matchingMid[0] : middleClusters[pitchTier % middleClusters.length];
      } else if (!isDropNote) {
        const phrase = Math.floor(n.time / (secPerBar * 2));
        const matching = introClusters.filter((c) => c.tier === pitchTier);
        const pool = matching.length > 0 ? matching : introClusters;
        cluster = pool[(phrase + idx + (isLowest12 ? 1 : 0)) % pool.length];
      } else {
        const phrase = Math.floor((n.time - dropTime) / (secPerBar * 1.5));
        const matching = dropClusters.filter((c) => c.tier === pitchTier);
        const pool = matching.length > 0 ? matching : dropClusters;
        cluster = pool[(phrase + Math.floor(h4 * 2) + idx) % pool.length];
      }

      // Spread stars out naturally around their cluster center across the full sky:
      const angle = idx * 2.3999632 + (h1 - 0.5) * 1.3;
      let spreadX;
      let spreadY;

      if (isMiddleSpawn) {
        // Gentle organic scatter around the 540 center axis
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
        x0 = Math.max(420, Math.min(660, x0));
      } else if (cluster.x < 540) {
        x0 = Math.max(75, Math.min(410, x0));
      } else {
        x0 = Math.max(670, Math.min(this.width - 75, x0));
      }

      // Anti-clumping relaxation: enforce minimum distance from other concurrently visible stars
      for (let iter = 0; iter < 12; iter++) {
        let tooClose = false;
        for (let j = Math.max(0, idx - 18); j < idx; j++) {
          const prev = seeds[j];
          if (Math.abs(prev.note.time - n.time) > 8.5) continue; // Only check stars active at the same time

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

      // Slow-motion cascading arc kinematics down to the sides:
      // Stars on the left half arc down-left (-1); stars on the right half arc down-right (+1);
      // Stars near the center alternate fan-out symmetrically across both flanks
      let arcDir;
      if (x0 < this.width * 0.46) {
        arcDir = -1; // Arc leftward
      } else if (x0 > this.width * 0.54) {
        arcDir = 1;  // Arc rightward
      } else {
        // Center notes fan out symmetrically across both flanks
        arcDir = (idx % 2 === 0 ? -1 : 1) * (h3 > 0.15 ? 1 : -1);
      }

      const defiesGravity = h4 > 0.82; // ~18% anchor stars float weightlessly
      const speedMult = tier === 'high' ? 0.7 : (tier === 'mid' ? 0.9 : 1.0);
      const dropLateralBoost = isDropNote ? 1.25 : 1.0;

      let vx0 = 0;
      let ax = 0;
      let vy0 = 0;
      let ay = 0;

      if (defiesGravity) {
        // Suspended anchor stars float weightlessly with gentle lateral drift
        vx0 = (h3 - 0.5) * (isMiddleSpawn ? 6.0 : 12.0) * speedMult * dropLateralBoost;
        vy0 = (h1 - 0.52) * 3.0 * speedMult;
        ax = 0;
        ay = 0;
      } else if (isMiddleSpawn) {
        // Slower outward arc for middle stars so constellations can form and linger in the center
        vx0 = (3.5 + h1 * 4.0 + n.velocity * 2.5) * speedMult * (isDropNote ? 1.15 : 1.0);
        ax = (0.4 + h3 * 0.6) * speedMult * (isDropNote ? 1.15 : 1.0);
        vy0 = (4 + h2 * 4.5) * speedMult;
        ay = (1.5 + h4 * 1.8 + n.velocity * 0.8) * speedMult;
      } else {
        // Slower cascading arc down to the sides (allowing constellations to form and stay linked):
        // Gentle downward drift (4-9 px/s) + gentle downward celestial gravity (1.5-3.2 px/s^2)
        // Gentle outward lateral speed (9-17 px/s) + gentle outward acceleration (1.2-2.7 px/s^2)
        vx0 = (9 + h1 * 8 + n.velocity * 5) * speedMult * dropLateralBoost;
        ax = (1.2 + h3 * 1.5) * speedMult * dropLateralBoost;
        vy0 = (4 + h2 * 5) * speedMult;
        ay = (1.5 + h4 * 1.8 + n.velocity * 0.8) * speedMult;
      }

        // Unique warmth shade for this star (from soft starlight to warm amber & golden pearl)
        const warmth = h4; // 0..1
        let colorR = 255;
        let colorG = Math.round(230 + warmth * 20);
        let colorB = Math.round(155 + (1 - warmth) * 90);

        // Star sizing: lowest 12 notes are a good bit bigger with major bloom halos
        let radius = 1.6 + n.velocity * 1.5;
        if (tier === 'low') {
          radius = 5.2 + n.velocity * 4.2; // A good bit bigger for lowest 12 notes (~7.3–9.4px)
        } else if (tier === 'high') {
          radius = 1.1 + n.velocity * 0.8; // small pinpoint shining dot
          colorG = Math.min(255, colorG + 15);
          colorB = Math.max(130, colorB - 20);
        }

        const topLinkChance = this.params.topStarLinkChance !== undefined ? this.params.topStarLinkChance : 0.22;
        const canLink = tier !== 'high' || (this._hash(idx * 47.9 + n.midi * 13.1 + n.time * 5.3) < topLinkChance);

        const rot0 = h1 * Math.PI * 2;
        const rotSpeed = (h2 > 0.5 ? 1 : -1) * (0.28 + h3 * 0.55);
        const fleckCount = tier === 'low' ? 3 : (tier === 'mid' ? 2 : 1);
        const dirtyFlecks = [];
        for (let fi = 0; fi < fleckCount; fi++) {
          const fH1 = this._hash(idx * 71.3 + fi * 29.7 + 1.2);
          const fH2 = this._hash(idx * 43.1 + fi * 17.9 + 5.8);
          dirtyFlecks.push({
            dist: 1.5 + fH1 * 1.9,
            angle: fH2 * Math.PI * 2,
            r: 0.16 + fH1 * 0.14
          });
        }

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
            rot0,
            rotSpeed,
            dirtyFlecks,
            radius,
            warmth,
            colorR,
            colorG,
            colorB,
            hasShootingTrail: tier !== 'high' && n.velocity > 0.82 && h2 > 0.75
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

  /**
   * Detects the musical chord at timestamp t from sounding and onset notes.
   * Determines root and quality (e.g. Bmaj, G#m7, F#maj, Emaj7).
   */
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

    // 1. Evaluate bass root first
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

    // 2. If no strong bass root match, evaluate other pitch classes
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

  /**
   * Computes all chord change markers across the entire track (intro + drop).
   */
  _computeChordTimelineMarkers() {
    const bpm = this.project.bpm || 120;
    const dur = this.project?.duration || 30.0;
  const dropTime = (typeof this.project?.dropTime === 'number' && !isNaN(this.project.dropTime))
    ? this.project.dropTime
    : (dur * 0.5);
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

/**
 * Computes a star's position & snappy arrival at timestamp `t`
 */
_getStarState(seed, t, driftMult) {
  const age = t - seed.note.time;
  if (age < 0) return null;

  const dAge = age * driftMult;
  const dur = this.project?.duration || 30.0;
  const dropTime = (typeof this.project?.dropTime === 'number' && !isNaN(this.project.dropTime))
    ? this.project.dropTime
    : (dur * 0.5);
  const isPreDropNote = seed.note.time < dropTime;

  // Pre-drop stars accelerate upwards and swoosh out before the drop pulse
  let preDropLiftY = 0;
  let preDropAlpha = 1;
  let streakStretch = 1;
  let isLifting = false;

  if (isPreDropNote) {
    if (t >= dropTime) {
      // Once the drop hits, intro stars have completely exited the scene into the pulse!
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

  // Celestial band drift: gentle top-left to bottom-right movement trend (+X, +Y)
  const bandDriftX = dAge * 15.0; // gentle rightward celestial stream
  const bandDriftY = dAge * 9.5;  // gentle downward celestial stream

  let arcX = 0;
  let arcY = 0;

  if (seed.defiesGravity) {
    // Celestial anchor stars: suspended in place with subtle weightless drift + band stream
    arcX = seed.vx0 * dAge + bandDriftX;
    arcY = seed.vy0 * dAge + bandDriftY;
  } else {
    // Cascading arc modulated with top-left to bottom-right celestial band flow
    const dAgeClamped = Math.min(12, dAge);
    arcX = (seed.arcDir * (seed.vx0 * dAgeClamped + 0.5 * seed.ax * dAgeClamped * dAgeClamped) * 0.65) + bandDriftX;
    arcY = (seed.vy0 * dAgeClamped + 0.5 * seed.ay * dAgeClamped * dAgeClamped) + bandDriftY;
  }

  // Organic multi-harmonic wandering (gentle pendulum sway superimposed on the arc)
  const wanderX =
    Math.sin(dAge * seed.freq1 + seed.phaseX1) * seed.amp1 +
    Math.sin(dAge * seed.freq2 + seed.phaseX2) * seed.amp2;
  const wanderY =
    Math.cos(dAge * seed.freq1 * 0.8 + seed.phaseY1) * (seed.amp1 * 0.32);

  const x = seed.x0 + arcX + wanderX;
  const y = seed.y0 + arcY + wanderY + preDropLiftY;

  // Fade out softly only as it approaches or passes the screen boundaries
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

  // Snappy arrival on note impact: fast pop-in in ~80ms
  const birthDuration = 0.08;
  const birthEase = Math.min(1, Math.max(0, age / birthDuration));

  // Snappy birth flare
  const flareDuration = seed.tier === 'high' ? 0.38 : 0.22;
  const flare = age < flareDuration ? Math.pow(1 - age / flareDuration, 2) : 0;

  // High notes shine strongly when spawned, then fade out quickly over ~1.6s
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
  const dropTime = (typeof this.project?.dropTime === 'number' && !isNaN(this.project.dropTime))
    ? this.project.dropTime
    : (dur * 0.5);
  const isPostDrop = tCurrent >= dropTime;
  const sunsetTarget = 40; // moody night-side dusk (subtle violet-indigo twilight, avoiding bright orange clip tint)

  if (isPostDrop) {
    const loopFade = this._getLoopFade(tCurrent);
    // Smoothly returns from sunset to baseTod at the loop seam
    return baseTod + (sunsetTarget - baseTod) * loopFade;
  }

  const { isLifting, liftEase } = this._getPreDropLift(tCurrent);
  if (isLifting) {
    // While pre-drop motion blur rushes upward, smoothly shift to sunset
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

  // 4 Keyframe Palettes: [top, mid, bot, horizon] + postDropBlend
  // Keyframe 0: Deep Night (tod = 0)
  const k0 = {
    top: [2 + postDropBlend * 1, 3 + postDropBlend * 1, 6 + postDropBlend * 3],
    mid: [4 + postDropBlend * 2, 6 + postDropBlend * 3, 12 + postDropBlend * 6],
    bot: [8 + postDropBlend * 3, 10 + postDropBlend * 3, 20 + postDropBlend * 6],
    horizon: [5 + postDropBlend * 2, 6 + postDropBlend * 2, 14 + postDropBlend * 4]
  };

  // Keyframe 1: Midnight / Standard (tod = 25) - identical baseline to original
  const k1 = {
    top: [4 + postDropBlend * 2, 5 + postDropBlend * 3, 10 + postDropBlend * 9],
    mid: [7 + postDropBlend * 5, 10 + postDropBlend * 8, 20 + postDropBlend * 20],
    bot: [12 + postDropBlend * 8, 16 + postDropBlend * 8, 32 + postDropBlend * 16],
    horizon: [8 + postDropBlend * 4, 10 + postDropBlend * 5, 22 + postDropBlend * 10]
  };

  // Keyframe 2: Sunset / Dusk (tod = 60) - warm anime twilight glow (middle of slider)
  const k2 = {
    top: [24 + postDropBlend * 4, 18 + postDropBlend * 2, 48 + postDropBlend * 8],
    mid: [92 + postDropBlend * 16, 38 + postDropBlend * 8, 76 + postDropBlend * 12],
    bot: [185 + postDropBlend * 25, 88 + postDropBlend * 12, 55 + postDropBlend * 8],
    horizon: [65 + postDropBlend * 8, 35 + postDropBlend * 6, 55 + postDropBlend * 8]
  };

  // Keyframe 3: Daylight Reference (tod = 100) - azure sky, lilac cloud, golden amber sunrise, violet mist hills
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

/**
 * Main render entry point for timestamp `t` (in seconds)
 * Deterministic 60fps frame generator
 */
renderFrame(tCurrent, activeVideoFrame = null) {
  const ctx = this.ctx;
  this._tCurrent = tCurrent;
  const W = this.width;
  const H = this.height;
  const dur = this.project?.duration || 30.0;
  const dropTime = (typeof this.project?.dropTime === 'number' && !isNaN(this.project.dropTime))
    ? this.project.dropTime
    : (dur * 0.5);
  const isPostDrop = tCurrent >= dropTime;
  const dropAge = isPostDrop ? tCurrent - dropTime : -1;
  const energy = this._getAudioEnergyAt(tCurrent);
  const bloom = this.params.bloomIntensity;

  // Pre-drop upward lift and motion blur factors (slower subtle drift early on, then rapid zoosh)
  const { pLift, liftEase, isLifting } = this._getPreDropLift(tCurrent);

  // 1. Organic camera sway, pre-drop tension rumble & drop impact punch
  const motionMult = this.params.cameraMotion || 1.0;
  let camX = 0;
  let camY = 0;
  let camRot = 0;

  if (motionMult > 0.01) {
    // Smooth transition from slow intro camera drift to energetic post-drop handheld motion
    const dropBlend = isPostDrop ? 1.0 : (isLifting ? Math.pow(pLift, 1.8) : 0.0);

    // 1a. Intro "non-drop" camera motion: much slower, graceful cosmic drift with calm breathing
    const swayIntroX = Math.sin(tCurrent * 0.20) * 3.2 + Math.sin(tCurrent * 0.44) * 1.2;
    const swayIntroY = Math.cos(tCurrent * 0.16) * 2.6 + Math.cos(tCurrent * 0.38) * 1.0;
    const jitterIntroX = Math.sin(tCurrent * 3.2) * 0.12;
    const jitterIntroY = Math.cos(tCurrent * 3.8) * 0.12;
    const rotIntro = Math.sin(tCurrent * 0.14) * 0.0010;

    // 1b. Post-drop camera motion: more active handheld sway and analog texture
    const swayDropX = Math.sin(tCurrent * 0.52) * 3.6 + Math.sin(tCurrent * 1.3) * 1.6;
    const swayDropY = Math.cos(tCurrent * 0.46) * 3.0 + Math.cos(tCurrent * 1.15) * 1.4;
    const jitterDropX = (Math.sin(tCurrent * 14.8) + Math.cos(tCurrent * 22.3)) * 0.42;
    const jitterDropY = (Math.cos(tCurrent * 16.4) + Math.sin(tCurrent * 20.8)) * 0.42;
    const rotDrop = Math.sin(tCurrent * 0.35) * 0.0016 + Math.cos(tCurrent * 8.5) * 0.0003;

    // Blend between slow non-drop float and active post-drop handheld
    const swayX = swayIntroX * (1 - dropBlend) + swayDropX * dropBlend;
    const swayY = swayIntroY * (1 - dropBlend) + swayDropY * dropBlend;
    const jitterX = jitterIntroX * (1 - dropBlend) + jitterDropX * dropBlend;
    const jitterY = jitterIntroY * (1 - dropBlend) + jitterDropY * dropBlend;
    const baseRot = rotIntro * (1 - dropBlend) + rotDrop * dropBlend;

    let tensionX = 0;
    let tensionY = 0;
    let tensionRot = 0;

    // Smooth building camera shake & upward screen lift right before the drop
    if (isLifting) {
      const tension = Math.pow(pLift, 2.8); // builds gently at first, then rapid tension
      tensionX = (Math.sin(tCurrent * 42) * 2.4 + Math.cos(tCurrent * 68) * 1.6) * tension * 7.0;
      // Subtle upward lift at start (-pLift * 10), then strong upward pull (-liftEase * 72)
      tensionY = -(pLift * 10 + liftEase * 72) + (Math.cos(tCurrent * 46) * 2.8 + Math.sin(tCurrent * 76) * 1.8) * tension * 7.0;
      tensionRot = Math.sin(tCurrent * 32) * 0.0038 * tension;
    }

    // Crisp drop impact punch shake that decays smoothly in ~380ms
    let impactX = 0;
    let impactY = 0;
    if (isPostDrop && dropAge >= 0 && dropAge < 0.38) {
      const punch = Math.pow(1 - dropAge / 0.38, 2.2);
      impactX = Math.sin(dropAge * 68) * 8.5 * punch;
      impactY = Math.cos(dropAge * 74) * 7.5 * punch;
    }

    // Camera motion: ease smoothly into the exact initial camera state at t = 0 (zero pixel snap)
    const cam0 = this._getInitialCameraState(motionMult);
    camX = (swayX + jitterX + tensionX + impactX) * motionMult;
    camY = (swayY + jitterY + tensionY + impactY) * motionMult;
    camRot = ((baseRot + tensionRot) * motionMult);

    const loopInfo = this._getLoopTransitionInfo(tCurrent);
    if (loopInfo.inTransition) {
      const p = loopInfo.progress;
      const easeP = p * p * (3 - 2 * p); // smooth hermite ease
      camX = camX * (1 - easeP) + cam0.x * easeP;
      camY = camY * (1 - easeP) + cam0.y * easeP;
      camRot = camRot * (1 - easeP) + cam0.rot * easeP;
    }
  }

  // 2. Base Canvas Background (Time of Day Sky Palette)
  // Seamless sky blend: at t -> duration, smoothly returns to intro night sky colors
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
  // Apply camera sway/shake transform to stage elements
  if (motionMult > 0.01) {
    ctx.translate(W * 0.5 + camX, H * 0.5 + camY);
    ctx.rotate(camRot);
    ctx.translate(-W * 0.5, -H * 0.5);
  }

  // 2b. Pre-Drop Background Motion Blur Warp Lines (hyper-drive whole screen upward rush)
  if (pLift > 0.005) {
    this._drawBackgroundMotionBlurWarp(ctx, tCurrent, pLift, liftEase, bloom);
  }

  // 3. Ambient Background Twinkling Stars
  this._drawAmbientNightStars(ctx, tCurrent, isPostDrop, energy, loopFade, pLift, liftEase);

  // 3b. Pre-Drop Infinitely Streaming Warp Sparkles (ascending with vertical motion blur)
  if (pLift > 0.005) {
    this._drawPreDropWarpSparkles(ctx, tCurrent, pLift, liftEase, bloom);
  }

  // 4. Melancholic Anime Scenery Layer (softly blending down into transparent piano roll)
  if (isPostDrop && activeVideoFrame) {
    this._drawAnimeDropLayer(ctx, activeVideoFrame, dropAge, energy, loopFade);
  }

  // 5. Post-Drop Celestial Nebula Glow (in front of video with additive warmth)
  if (isPostDrop) {
    this._drawNebulaAndStardust(ctx, tCurrent, dropAge, energy, bloom, loopFade);
  }

  // 6. Radiant Shooting Stars (in front of the video!)
  if (isPostDrop) {
    this._drawShootingStars(ctx, dropAge, bloom, loopFade);
  }

  // 9. Visible MIDI Stars with Warm Bloom & Pre-Drop Swoosh Lift-off
  this._drawConstellationsAndStars(ctx, tCurrent, isPostDrop, dropAge, energy, bloom, loopFade);

  // 10. Drop "Explosion of Prettiness" Luminous Shockwave Flash
  if (isPostDrop && dropAge >= 0 && dropAge < 2.2) {
    this._drawDropExplosionFlash(ctx, dropAge, bloom);
  }

  // 10b. Dynamic Chord Change / Impact Camera Lens Flare
  if (isPostDrop && dropAge >= 0.2) {
    const cutInfo = this._getRecentCutInfo(tCurrent);
    if (cutInfo) {
      this._drawChordCutFlash(ctx, cutInfo, bloom);
    }
  }

  ctx.restore();

  // 8. Bottom Blended Liquid Glass Piano Roll (Seamlessly over the background)
  this._drawPianoRoll(ctx, tCurrent, isPostDrop, energy);

  // 8b. Track info stack centered directly above the piano roll (title over key/bpm, subtle artist underneath)
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
        // Warm anime skin tone profile: R > G > B with warm blush/peach saturation
        const isSkin = (r > 115 && g > 85 && b > 65 && r > g && g > b && (r - b) > 20 && (r - g) > 10 && (r - g) < 75);
        // High-frequency ink line / silhouette edge contrast
        let edge = 0;
        if (x > 0 && x < w - 1) {
          edge = Math.abs(d[idx + 4] - d[idx - 4]);
        }
        const score = (isSkin ? 8.0 : 0.0) + (edge > 25 ? 1.5 : 0.0);
        colScores[x] += score;
      }
    }

    // Find 9:16 aspect window (width ~ 51px) with the highest subject density
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

    // Map to normalized focus anchor clamped between 0.18 and 0.82
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
  const dropTime = (typeof this.project?.dropTime === 'number' && !isNaN(this.project.dropTime))
    ? this.project.dropTime
    : (dur * 0.5);
  const tCurrent = dropAge + dropTime;

  // Subtle drop glitch transition window (first 200ms at drop point)
  const hasGlitch = this.params.dropGlitch !== false && dropAge >= 0 && dropAge < 0.20;
  const glitchEnv = hasGlitch ? Math.pow(Math.max(0, 1 - dropAge / 0.20), 2.2) : 0;

  // Snappy glitch-out transition during early half of the loop transition window
  const loopInfo = this._getLoopTransitionInfo(tCurrent);
  const glitchOutDur = Math.min(0.55, (loopInfo.loopWin || 0.85) * 0.65);
  const timeUntilLoop = Math.max(0, dur - tCurrent);
  const hasGlitchOut = this.params.dropGlitch !== false && timeUntilLoop < glitchOutDur && loopInfo.inTransition;
  const glitchOutProgress = hasGlitchOut ? Math.max(0, Math.min(1.0, 1.0 - timeUntilLoop / glitchOutDur)) : 0;
  // Glitch envelope peaks in the middle and completely decays to 0 before the final frames
  const glitchOutEnv = hasGlitchOut
    ? (glitchOutProgress < 0.45
        ? Math.pow(glitchOutProgress / 0.45, 1.2)
        : Math.pow(Math.max(0, 1.0 - (glitchOutProgress - 0.45) / 0.55), 1.6))
    : 0;

  // Smooth reveal curve at drop and seamless loop dissolve at the end
  // When glitch is active, the frame punches through immediately without feeling sluggish
  const revealFactor = hasGlitch
    ? Math.min(1, 0.62 + (1 - glitchEnv) * 0.38 + dropAge * 1.2)
    : Math.min(1, 0.35 + dropAge * 1.4);

  // Clip fade completely reaches 0 by p = 0.70 of loop window (before seam)
  const effectiveFade = loopInfo.clipFade;
  const targetAlpha = this.params.animeOpacity * revealFactor * (0.88 + energy * 0.16) * effectiveFade;
  if (targetAlpha <= 0.005) {
    ctx.restore();
    return;
  }
  ctx.globalAlpha = Math.max(0, Math.min(0.95, targetAlpha));

  // Speed ramp calculation & dynamic zoom punch into cuts
  const ramp = this.getSpeedRampInfo(tCurrent);
  const rampZoom = ramp.isRamping ? ramp.rampFactor * 0.045 : 0;

  // Cover-fit video across the entire frame with gentle slow cinematic zoom & dynamic speed ramp punch
  const glitchPunch = (hasGlitch && dropAge < 0.08 ? 0.015 * Math.pow(1 - dropAge / 0.08, 2.0) : 0)
    + (hasGlitchOut ? 0.018 * Math.pow(glitchOutProgress, 2.0) : 0);
  const zoom = 1.02 + Math.sin(dropAge * 0.22) * 0.02 + rampZoom;
  const scale = Math.max(this.width / vw, this.height / vh) * zoom;
  const drawW = vw * scale * (1 + glitchPunch);
  const drawH = vh * scale;

  // Smart Auto-Framing: centers characters & key subjects within 9:16 vertical crop
  let targetFocalX = 0.5;
  if (this.params.autoFrame !== false) {
    if (videoEl.dataset && videoEl.dataset.manualFocalX) {
      targetFocalX = parseFloat(videoEl.dataset.manualFocalX) || 0.5;
    } else {
      targetFocalX = this.detectClipFocalPoint(videoEl);
    }
  }
  // Smoothly ease focal point to prevent jerky camera jumps between cuts
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

  // Subtle drop glitch-in effect (scanline band jitter, chromatic split, and neon scanlines)
  if (hasGlitch && glitchEnv > 0.005) {
    this._drawDropGlitchIn(ctx, videoEl, dropAge, glitchEnv, drawX, drawY, drawW, drawH, vw, vh);
  }

  // Snappy glitch-out effect at reel loop end
  if (hasGlitchOut && glitchOutEnv > 0.005) {
    this._drawDropGlitchOut(ctx, videoEl, glitchOutProgress, glitchOutEnv, drawX, drawY, drawW, drawH, vw, vh);
  }

  // Speed ramp horizontal starlight whip streaks across video during transition
  if (ramp.isRamping && ramp.rampFactor > 0.25) {
    this._drawSpeedRampWhipLines(ctx, ramp.rampFactor, this.params.bloomIntensity);
  }

  // Soft atmospheric vignette at top canvas edge
  ctx.globalAlpha = 1;
  const vigTop = ctx.createLinearGradient(0, 0, 0, 90);
  vigTop.addColorStop(0, 'rgba(5, 7, 13, 0.42)');
  vigTop.addColorStop(1, 'rgba(5, 7, 13, 0)');
  ctx.fillStyle = vigTop;
  ctx.fillRect(0, 0, this.width, 90);

  // Soft celestial indigo tint across video
  ctx.fillStyle = 'rgba(10, 16, 32, 0.16)';
  ctx.fillRect(0, 0, this.width, this.height);

  ctx.restore();
}

_drawDropGlitchIn(ctx, videoEl, dropAge, glitchEnv, drawX, drawY, drawW, drawH, vw, vh) {
  if (glitchEnv <= 0.005) return;

  // Discretize into snappy frame steps (~45fps quantization) for authentic CRT/digital bite
  const glitchStep = Math.floor(dropAge * 45);

  // 1. Full-frame RGB chromatic split ghosting during the first 90ms of entry
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

  // 2. Horizontal slice jitter (3-5 horizontal bands displaced horizontally)
  const sliceCount = 4;
  for (let i = 0; i < sliceCount; i++) {
    const seed = glitchStep * 23.3 + i * 17.1;
    const normY = ((this._hash(seed + 0.3) * 0.75) + i * 0.2 + 0.04) % 0.86;
    const normH = 0.025 + this._hash(seed + 1.9) * 0.065; // ~2.5% to 9% height
    const dir = (i % 2 === 0) ? 1 : -1;
    const jitterX = dir * (5 + this._hash(seed + 3.7) * 14) * glitchEnv;

    const sy = normY * vh;
    const sh = Math.min(normH * vh, vh - sy);
    const dy = drawY + normY * drawH;
    const dh = normH * drawH;

    // Draw displaced video slice
    ctx.drawImage(videoEl, 0, sy, vw, sh, drawX + jitterX, dy, drawW, dh);

    // Subtle cyan/magenta fringe along displaced horizontal band edges
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const fringeAlpha = (0.24 * glitchEnv).toFixed(3);
    // Left edge cyan fringe
    ctx.fillStyle = `rgba(0, 240, 255, ${fringeAlpha})`;
    ctx.fillRect(drawX + jitterX - 2, dy, 5, dh);
    // Right edge magenta fringe
    ctx.fillStyle = `rgba(255, 45, 120, ${fringeAlpha})`;
    ctx.fillRect(drawX + jitterX + drawW - 3, dy, 5, dh);
    ctx.restore();
  }

  // 3. High-frequency digital scanline flickers
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const scanSeed = glitchStep * 41.3;
  const y1 = drawY + ((this._hash(scanSeed) * 0.88 + 0.06) % 0.94) * drawH;
  const y2 = drawY + ((this._hash(scanSeed + 8.9) * 0.85 + 0.08) % 0.92) * drawH;

  // Cyan/white luminous scanline
  ctx.fillStyle = `rgba(200, 245, 255, ${(0.38 * glitchEnv).toFixed(3)})`;
  ctx.fillRect(0, y1, this.width, 1.8);

  // Soft violet scanline
  ctx.fillStyle = `rgba(225, 185, 255, ${(0.28 * glitchEnv).toFixed(3)})`;
  ctx.fillRect(0, y2, this.width, 2.2);

  // Micro flash band (semi-transparent horizontal strip)
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

  // Discretize into snappy frame steps (~45fps quantization) for digital glitch bite
  const glitchStep = Math.floor(glitchProgress * 45);

  // 1. Full-frame RGB chromatic split ghosting (expands as glitch escalates)
  const rgbEnv = Math.pow(glitchProgress, 1.2);
  const shiftX = (6.0 + this._hash(glitchStep * 9.3) * 6.0) * rgbEnv;
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.globalAlpha = 0.32 * rgbEnv;
  ctx.drawImage(videoEl, drawX + shiftX, drawY, drawW, drawH);
  ctx.drawImage(videoEl, drawX - shiftX, drawY, drawW, drawH);
  ctx.restore();

  // 2. Horizontal slice jitter (5 horizontal bands displaced horizontally)
  const sliceCount = 5;
  for (let i = 0; i < sliceCount; i++) {
    const seed = glitchStep * 29.7 + i * 19.3;
    const normY = ((this._hash(seed + 0.5) * 0.78) + i * 0.18 + 0.02) % 0.88;
    const normH = 0.03 + this._hash(seed + 2.1) * 0.08; // ~3% to 11% height
    const dir = (i % 2 === 0) ? 1 : -1;
    const jitterX = dir * (8 + this._hash(seed + 4.1) * 18) * glitchEnv;

    const sy = normY * vh;
    const sh = Math.min(normH * vh, vh - sy);
    const dy = drawY + normY * drawH;
    const dh = normH * drawH;

    // Draw displaced video slice
    ctx.drawImage(videoEl, 0, sy, vw, sh, drawX + jitterX, dy, drawW, dh);

    // Subtle cyan/magenta fringe along displaced horizontal band edges
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const fringeAlpha = (0.32 * glitchEnv).toFixed(3);
    // Left edge cyan fringe
    ctx.fillStyle = `rgba(0, 240, 255, ${fringeAlpha})`;
    ctx.fillRect(drawX + jitterX - 3, dy, 6, dh);
    // Right edge magenta fringe
    ctx.fillStyle = `rgba(255, 45, 120, ${fringeAlpha})`;
    ctx.fillRect(drawX + jitterX + drawW - 3, dy, 6, dh);
    ctx.restore();
  }

  // 3. Digital scanline flickers & micro flash band
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const scanSeed = glitchStep * 37.1;
  const y1 = drawY + ((this._hash(scanSeed) * 0.88 + 0.06) % 0.94) * drawH;
  const y2 = drawY + ((this._hash(scanSeed + 9.7) * 0.85 + 0.08) % 0.92) * drawH;

  // Cyan/white luminous scanline
  ctx.fillStyle = `rgba(200, 245, 255, ${(0.42 * glitchEnv).toFixed(3)})`;
  ctx.fillRect(0, y1, this.width, 2.0);

  // Soft violet scanline
  ctx.fillStyle = `rgba(225, 185, 255, ${(0.32 * glitchEnv).toFixed(3)})`;
  ctx.fillRect(0, y2, this.width, 2.5);

    // Micro flash band: peaks smoothly in middle of glitch, cleanly resolves to 0 before loop seam
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

  // Slower, more eased transition ramp duration (~0.72s, up to 40% of the cut)
  const rampDur = Math.min(0.72, D * 0.40);

  // Cinematic slow motion in the middle between clips (0.48x speed)
  const Sbase = 0.48;
  // Fast whip acceleration into and out of cuts (2.85x speed)
  const Smax = 2.85;
  const Sdiff = Smax - Sbase;

  // Composite easing curve: slower movement for longer at the start, then rapid whip acceleration
  const c1 = 0.28;
  const c2 = 0.72; // c1 + c2 === 1.0
  const areaCoeff = c1 / 3 + c2 / 5;
  const entryArea = Sbase * rampDur + Sdiff * rampDur * areaCoeff;

  if (elapsed <= rampDur) {
    // Entry phase: decelerating out of the cut from Smax down into Sbase (slow-mo)
    const p = (rampDur - elapsed) / rampDur; // 1 -> 0
    const ease = c1 * Math.pow(p, 2) + c2 * Math.pow(p, 4);
    const instSpeed = Sbase + Sdiff * ease;

    const w = rampDur - elapsed;
    const term = Sbase * w + Sdiff * ((c1 * Math.pow(w, 3)) / (3 * rampDur * rampDur) + (c2 * Math.pow(w, 5)) / (5 * Math.pow(rampDur, 4)));
    const clipTime = entryArea - term;

    return { clipTime, instSpeed, rampFactor: ease, isRamping: true, phase: 'in' };
  } else if (elapsed <= D - rampDur) {
    // Cruising phase: steady dreamy cinematic slow-motion between the clips
    const clipTime = entryArea + Sbase * (elapsed - rampDur);
    return { clipTime, instSpeed: Sbase, rampFactor: 0, isRamping: false, phase: 'cruise' };
  } else {
    // Exit phase: slowly easing out of slow-mo, then rapidly accelerating up to Smax into next cut
    const u = elapsed - (D - rampDur); // 0 -> rampDur
    const p = u / rampDur; // 0 -> 1
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
  const dur = this.project?.duration || 30.0;
  const dropTime = (typeof this.project?.dropTime === 'number' && !isNaN(this.project.dropTime))
    ? this.project.dropTime
    : (dur * 0.5);
  const preDropDur = this.params?.preDropDuration || 2.2;
  const dt = Math.max(0, t - (dropTime - preDropDur));
  const warpStreakLen = Math.min(540, 24 + liftEase * 440 + Math.pow(pLift, 2.5) * 80);

  for (const line of this.bgWarpLines) {
    // Slower subtle float at first (dt * 0.4) then massive upward surge (liftEase * H * 1.4)
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
  // Starts subtly drifting up (pLift * 36px), then rockets up during rapid zoosh (liftEase * H * 1.35)
  const liftDist = isLifting ? (pLift * 36 + liftEase * (H * 1.35)) : 0;
  // Motion blur streaks only stretch noticeably during the rapid zoosh phase
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
      // Vertical motion blur trail stretching downward from rising star head
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
  const dur = this.project?.duration || 30.0;
  const dropTime = (typeof this.project?.dropTime === 'number' && !isNaN(this.project.dropTime))
    ? this.project.dropTime
    : (dur * 0.5);
  const preDropDur = this.params?.preDropDuration || 2.2;
  const dt = Math.max(0, t - (dropTime - preDropDur));
  const inWindowFade = Math.min(1.0, pLift * 2.2);

  for (const sp of this.preDropSparkles) {
    // Early subtle upward drift (sp.speed * dt * 0.38) + rapid zoosh boost (liftEase * H * 1.45)
    const dist = sp.speed * dt * 0.38 + liftEase * (H * 1.45);
    // Seamless infinite vertical wrapping
    const curY = ((sp.y0 - dist) % H + H) % H;
    const curX = sp.x0 + Math.sin(t * 3.6 + sp.phase) * (sp.driftX * 0.4 + liftEase * 12);

    const twinkle = 0.4 + 0.6 * Math.sin(t * sp.twinkleSpeed + sp.phase);
    const alpha = inWindowFade * twinkle * Math.min(1.0, 0.38 + liftEase * 0.62);
    if (alpha <= 0.01) continue;

    // Vertical motion blur: starts as compact sparkling dots (6px), stretching into warp streaks as zoosh kicks in
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

    // 1. Motion blur gradient streak
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

    // 2. Soft starlight aura on particle head
    const auraR = sp.size * (2.8 + liftEase * 2.4);
    const auraGrad = ctx.createRadialGradient(curX, curY, 0, curX, curY, auraR);
    auraGrad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${(alpha * 0.48).toFixed(3)})`);
    auraGrad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
    ctx.fillStyle = auraGrad;
    ctx.beginPath();
    ctx.arc(curX, curY, auraR, 0, Math.PI * 2);
    ctx.fill();

    // 3. Crisp center pinpoint
    ctx.fillStyle = `rgba(${coreR}, ${coreG}, ${coreB}, ${Math.min(1.0, alpha * 1.15).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(curX, curY, sp.size * (0.8 + liftEase * 0.4), 0, Math.PI * 2);
    ctx.fill();

    // 4. Subtle 4-point cross-glint on larger radiant sparkles
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

  // Soft audio-reactive celestial nebula glow
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

  // Rising luminous stardust particles
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

  // Shooting stars appear gracefully every ~4.5 seconds after the drop
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

    // Smooth opacity curve: gradual ignite, peak mid-streak, smooth fade
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

    // Warm luminous gradient trail
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

    // Thin bright core
    ctx.strokeStyle = `rgba(255, 255, 255, ${(alpha * 0.95).toFixed(3)})`;
    ctx.lineWidth = 1.0;
    ctx.beginPath();
    ctx.moveTo(headX - Math.cos(angle) * (trailLength * 0.35), headY - Math.sin(angle) * (trailLength * 0.35));
    ctx.lineTo(headX, headY);
    ctx.stroke();

    // Radiant head glow
    const headGlowR = (10 + h1 * 6) * (0.8 + bloom * 0.4);
    const headGrad = ctx.createRadialGradient(headX, headY, 0, headX, headY, headGlowR);
    headGrad.addColorStop(0, `rgba(255, 255, 255, ${alpha.toFixed(3)})`);
    headGrad.addColorStop(0.35, `rgba(${r}, ${g}, ${b}, ${(alpha * 0.6).toFixed(3)})`);
    headGrad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);

    ctx.fillStyle = headGrad;
    ctx.beginPath();
    ctx.arc(headX, headY, headGlowR, 0, Math.PI * 2);
    ctx.fill();

    // Sharp pinpoint star center
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

  // When anime clip plays after the drop, stars fade softly into the background
  // During loop outro, all post-drop constellation stars smoothly fade out with loopFade
  // so the night sky returns cleanly to the pristine intro state (0 post-drop stars)
  const postDropDim = isPostDrop ? Math.max(0.36, 1.0 - Math.min(1.0, dropAge * 0.7) * 0.64) : 1.0;
  const postDropFade = isPostDrop ? (postDropDim * loopFade) : 1.0;
  const postDropScale = isPostDrop ? 0.78 : 1.0;

  // 1. Constellation Connection Lines: between main stars (low & mid tiers, plus small chance for top stars)
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

    // 2. Render Stars according to their 3 tiers
    for (const st of visibleStars) {
      const { seed, x, y, alpha, flare } = st;
      const sR = Math.round(seed.colorR * (1 - dayInvert) + 36 * dayInvert);
      const sG = Math.round(seed.colorG * (1 - dayInvert) + 66 * dayInvert);
      const sB = Math.round(seed.colorB * (1 - dayInvert) + 124 * dayInvert);
      const coreR = Math.round(255 * (1 - dayInvert) + 18 * dayInvert);
      const coreG = Math.round(255 * (1 - dayInvert) + 32 * dayInvert);
      const coreB = Math.round(255 * (1 - dayInvert) + 58 * dayInvert);
      const effAlpha = alpha * postDropFade;

      // Pre-drop upward motion streaks when accelerating into the swoosh
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

      // Subtle suspended starlight halo for anchor stars defying gravity
      if (seed.defiesGravity && !st.isLifting) {
        const susR = seed.radius * (2.8 + flare * 1.2);
        ctx.strokeStyle = `rgba(${sR}, ${sG}, ${sB}, ${(effAlpha * 0.28).toFixed(3)})`;
        ctx.lineWidth = 0.75;
        ctx.beginPath();
        ctx.arc(x, y, susR, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Cinematic 4-Point Needle Starburst (Shinkai / Kimi no Na wa Style)
      const baseR = seed.radius * (1.0 + flare * 0.45) * postDropScale;

      // Atmospheric optical scintillation (realistic starlight shimmer)
      const scint = 0.86 + 0.14 * Math.sin(t * 9.5 + seed.idx * 4.3);
      const starAlpha = Math.min(1.0, effAlpha * scint);

      ctx.save();
      ctx.translate(x, y);
      // Fixed optical camera orientation: all flares share the camera's physical horizontal/vertical aperture axes

      // 1. Soft Warm Atmospheric Bloom Halo (Organic celestial haze)
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

      // 2. Needle-Sharp 4-Point Shinkai Starburst Rays
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

        // 4 Primary Needle Spikes (0°, 90°, 180°, 270°)
        drawNeedle(lenH, needleW, rayAlpha);
        ctx.save(); ctx.rotate(Math.PI); drawNeedle(lenH, needleW, rayAlpha); ctx.restore();
        ctx.save(); ctx.rotate(Math.PI * 0.5); drawNeedle(lenV, needleW, rayAlpha); ctx.restore();
        ctx.save(); ctx.rotate(-Math.PI * 0.5); drawNeedle(lenV, needleW, rayAlpha); ctx.restore();

        // 3. Faint 45-Degree Secondary Glints (Celestial depth)
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

      // 4. Glowing Radiant Core Nucleus
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

      // Brilliant white nucleus point
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

    // Expanding luminous shockwave ring
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
    const dur = this.project?.duration || 30.0;
  const dropTime = (typeof this.project?.dropTime === 'number' && !isNaN(this.project.dropTime))
    ? this.project.dropTime
    : (dur * 0.5);
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
    const window = 0.32; // optical camera flare decay window

    for (let i = 0; i < cuts.length; i++) {
      const c = cuts[i];
      const dt = tCurrent - c;
      // Skip the main drop point (main explosion handles it)
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
    // Optical decay curve: fast energetic burst at shutter cut that dissipates smoothly
    const flareEnv = Math.pow(Math.max(0, 1 - progress), 2.2);
    if (flareEnv <= 0.005) return;

    ctx.save();
    ctx.globalCompositeOperation = 'screen';

    const W = this.width;
    const H = this.height;
    const centerX = this.skyCenterX;
    const centerY = this.skyCenterY;

    // Flare hotspot origin in celestial sky (varied per cut for natural cinematic camera angle cuts)
    const hashA = this._hash(cutIdx * 19.3 + 3.7);
    const hashB = this._hash(cutIdx * 31.7 + 7.1);
    const flareX = W * (0.34 + hashA * 0.32);
    const flareY = this.skyTop + (this.pianoRollTop - this.skyTop) * (0.28 + hashB * 0.24);

    // 1. Soft atmospheric optical bloom (diffuse spherical wash around light origin)
    const washRadius = 620 * (0.8 + 0.2 * flareEnv);
    const washAlpha = 0.24 * flareEnv * (0.8 + bloom * 0.35);
    const washGrad = ctx.createRadialGradient(flareX, flareY, 15, flareX, flareY, washRadius);
    washGrad.addColorStop(0, `rgba(255, 245, 215, ${washAlpha.toFixed(3)})`);
    washGrad.addColorStop(0.32, `rgba(255, 210, 145, ${(washAlpha * 0.55).toFixed(3)})`);
    washGrad.addColorStop(0.72, `rgba(175, 155, 245, ${(washAlpha * 0.22).toFixed(3)})`);
    washGrad.addColorStop(1, 'rgba(10, 15, 30, 0)');
    ctx.fillStyle = washGrad;
    ctx.fillRect(0, 0, W, H);

    // 2. Cinema Anamorphic Horizontal Laser Streak
    // 2a. Soft diffuse anamorphic beam band
    const bandH = (32 + 20 * flareEnv) * (0.85 + bloom * 0.25);
    const bandGrad = ctx.createLinearGradient(0, flareY - bandH * 0.5, 0, flareY + bandH * 0.5);
    bandGrad.addColorStop(0, 'rgba(255, 210, 130, 0)');
    bandGrad.addColorStop(0.5, `rgba(255, 235, 195, ${(0.32 * flareEnv).toFixed(3)})`);
    bandGrad.addColorStop(1, 'rgba(255, 210, 130, 0)');
    ctx.fillStyle = bandGrad;
    ctx.fillRect(0, flareY - bandH * 0.5, W, bandH);

    // 2b. Razor-sharp horizontal anamorphic streak core
    const razorH = Math.max(1.8, 3.2 * flareEnv);
    const razorGrad = ctx.createRadialGradient(flareX, flareY, 0, flareX, flareY, W * 0.54);
    razorGrad.addColorStop(0, `rgba(255, 255, 255, ${(0.96 * flareEnv).toFixed(3)})`);
    razorGrad.addColorStop(0.2, `rgba(220, 245, 255, ${(0.80 * flareEnv).toFixed(3)})`);
    razorGrad.addColorStop(0.55, `rgba(135, 205, 255, ${(0.38 * flareEnv).toFixed(3)})`);
    razorGrad.addColorStop(1, 'rgba(90, 150, 255, 0)');
    ctx.fillStyle = razorGrad;
    ctx.fillRect(0, flareY - razorH * 0.5, W, razorH);

    // 2c. Subtle chromatic aberration micro-streaks (+1.6px cyan, -1.6px warm amber)
    const fringeAlpha = (0.24 * flareEnv).toFixed(3);
    ctx.fillStyle = `rgba(100, 225, 255, ${fringeAlpha})`;
    ctx.fillRect(0, flareY - razorH * 0.5 - 1.6, W, 1.2);
    ctx.fillStyle = `rgba(255, 140, 85, ${fringeAlpha})`;
    ctx.fillRect(0, flareY + razorH * 0.5 + 0.6, W, 1.2);

    // 3. Core optical hotspot burst
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

    // 4. Optical Lens Ghosts along the optical axis (connecting hotspot to lens center)
    const axisDx = centerX - flareX;
    const axisDy = centerY - flareY;

    // Ghost 1: Warm amber circular aperture iris ring
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

    // Ghost 2: Cyan/sapphire wide ethereal reflection disc (past the center)
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

    // Ghost 3: Crisp subtle violet micro-dot
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
    const H = this.height - top;
    const W = this.width;
    const playheadX = 250;
    const pxPerSec = 175;
    const dayInvert = this._getDayInvertFactor(t);

    ctx.save();

    // Completely transparent background — whole box fill & divider line removed per user request

    // Notes label & source (clean lowercase, smoothly inverts in bright day)
    ctx.textAlign = 'left';
    ctx.fillStyle = this._mixRgb(237, 240, 248, 20, 26, 36, dayInvert);
    ctx.font = '600 24px "Space Grotesk", sans-serif';
    ctx.fillText('• notes', 48, top + 42);

    // Sample name & index number on the same line, aligned to the right
    const title = (this.project.title || 'untitled').toLowerCase();
    const rawNum = this.project.sampleNumber ? String(this.project.sampleNumber).trim() : '';
    const numFormatted = rawNum ? (rawNum.startsWith('#') ? rawNum : `#${rawNum}`) : '';
    const sampleDisplay = numFormatted ? `${numFormatted} · ${title}` : title;

    ctx.textAlign = 'right';
    ctx.fillStyle = this._mixRgb(237, 240, 248, 20, 26, 36, dayInvert);
    ctx.font = '600 24px "IBM Plex Mono", monospace';
    ctx.fillText(sampleDisplay, W - 48, top + 42);

    // Left subtitle: source
    ctx.textAlign = 'left';
    const activeTrackNames = this.rawTracks
      .filter((tr) => this.selectedTrackIds.has(tr.id))
      .map((tr) => tr.name.toLowerCase())
      .join(' + ');
    ctx.fillStyle = this._mixRgba(165, 175, 205, 0.75, 50, 62, 85, 0.80, dayInvert);
    ctx.font = '500 16px "IBM Plex Mono", monospace';
    ctx.fillText(`source · ${activeTrackNames || 'midi'}`, 48, top + 72);

    // Roll grid bounds
    const gridTop = top + 92;
    const gridBottom = this.height - 54;
    const gridHeight = gridBottom - gridTop;
    const gridLeft = 105;

    // Left pitch scale ticks
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

    // Clip note & bar grid area
    ctx.beginPath();
    ctx.rect(gridLeft, gridTop - 28, W - gridLeft - 32, gridHeight + 40);
    ctx.clip();

    // Horizontal subtle pitch guide lines
    ctx.strokeStyle = this._mixRgba(255, 255, 255, 0.04, 0, 0, 0, 0.05, dayInvert);
    for (let i = 0; i <= 8; i++) {
      const gy = gridTop + (i / 8) * gridHeight;
      ctx.beginPath();
      ctx.moveTo(gridLeft, gy);
      ctx.lineTo(W - 32, gy);
      ctx.stroke();
    }

    // Scrolling Bar Grid Lines & Bar Numbers (1, 2, 3, 4...)
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

      const normBar = ((b % totalBars) + totalBars) % totalBars; // Circular 0..totalBars-1
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

    // Dynamic Chord Markers on Piano Roll (full track: intro + drop)
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

    // Draw Scrolling MIDI Notes (with seamless circular infinite belt wrapping)
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

        // Playhead contact burst circle
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
        // As song approaches end, project upcoming intro notes forward so they roll in from the right edge
        if (t > dur - 6.0 && n.time < 6.0) {
          drawNoteBar(n, n.time + dur, true);
        }
        // At start of loop, project trailing drop notes backward so they smoothly exit past the left playhead
        if (t < 2.5 && n.time > dur - 3.0) {
          drawNoteBar(n, n.time - dur, false);
        }
      }
    }

    // Vertical Playhead Line (smoothly blends from post-drop gold back to intro silver at loop seam)
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

    // Drop shadow for crisp contrast over video & falling stars (smoothly inverts to soft backlight during bright day)
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

    // 1. Key & BPM centered above piano roll (smoothly inverts to dark slate during bright day)
    ctx.font = '600 32px "IBM Plex Mono", monospace';
    ctx.fillStyle = this._mixRgb(226, 232, 245, 30, 38, 54, dayInvert);
    ctx.fillText(text, W * 0.5, baseY - 56);

    // 2. Artist name underneath in small and grey
    ctx.font = '500 20px "IBM Plex Mono", monospace';
    ctx.fillStyle = this._mixRgba(165, 178, 205, 0.78, 65, 75, 95, 0.80, dayInvert);
    ctx.fillText(artist, W * 0.5, baseY - 20);

    ctx.restore();
  }

  // Alias for backward compatibility
  _drawKeyAndBpm(ctx, isPostDrop, postDropBlend = 0) {
    this._drawTrackInfoAbovePianoRoll(ctx, isPostDrop, postDropBlend);
  }

  _drawMinimalHeader() {
    // Complete top line of the screen and top header bar removed per user request
  }
}

window.SampleVisualizer = SampleVisualizer;
