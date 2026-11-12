// built-in 3-box presets: constellations, cinematic-minimal, anime-chord-flow
(function () {
  'use strict';

  const CONSTELLATIONS_PRESET = {
    version: '1.0',
    id: 'constellations',
    meta: {
      name: 'Constellations',
      title: 'Constellations',
      description: 'Celestial starfield and piano roll with anime drop compositing',
      aspectRatio: '9:16',
      badge: 'Signature'
    },

    shaderBox: {
      fragmentShader: `
        precision mediump float;
        varying vec2 v_uv;
        uniform vec2 u_resolution;
        uniform float u_time;
        uniform float u_bass;
        uniform float u_mid;
        uniform float u_high;
        uniform float u_rms;
        uniform float u_note_hit;
        uniform float timeOfDay;
        uniform float sunsetDropTransition;

        float hash21(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }

        void main() {
          vec2 uv = v_uv;
          // sky gradient background
          vec3 topNight = vec3(0.03, 0.04, 0.09);
          vec3 botNight = vec3(0.08, 0.12, 0.22);
          vec3 sky = mix(topNight, botNight, uv.y);

          // subtle cosmic dust / nebula shimmer
          float n = hash21(floor(uv * 180.0));
          if (n > 0.985) {
            float twinkle = sin(u_time * 2.5 + n * 6.28) * 0.5 + 0.5;
            sky += vec3(0.12, 0.16, 0.28) * twinkle * (0.8 + u_high * 0.5);
          }

          // audio bass warmth at horizon
          sky += vec3(0.04, 0.03, 0.08) * u_bass * smoothstep(0.4, 1.0, uv.y);

          gl_FragColor = vec4(sky, 1.0);
        }
      `
    },

    frontUiBox: {
      initScript: `
        // initialize constellations shinkai state
        state.project = project;
        const W = project.aspectRatio === '16:9' ? 1920 : 1080;
        const H = project.aspectRatio === '16:9' ? 1080 : 1920;

        state.width = W;
        state.height = H;
        state.pianoRollTop = Math.round(H * 0.724);
        state.skyTop = 0;
        state.skyHeight = state.pianoRollTop;
        state.skyCenterX = W * 0.5;
        state.skyCenterY = state.skyHeight * 0.48;

        state.hash = function(n) {
          const s = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
          return s - Math.floor(s);
        };

        // ambient background stars
        state.bgStars = [];
        const dur = project.duration || 29.09;
        const baseFreq = (Math.PI * 2) / dur;
        for (let i = 0; i < 160; i++) {
          const rawSpeed = 0.6 + state.hash(i * 23.9) * 2.0;
          const harmonicK = Math.max(1, Math.round(rawSpeed / baseFreq));
          state.bgStars.push({
            x: state.hash(i * 3.1) * W,
            y: state.skyTop + state.hash(i * 7.3) * (H - state.skyTop),
            r: 0.6 + state.hash(i * 11.7) * 1.5,
            phase: state.hash(i * 19.3) * Math.PI * 2,
            speed: harmonicK * baseFreq,
            warmth: state.hash(i * 3.7 + 1.2)
          });
        }

        // stardust & warp lines
        state.stardust = [];
        for (let i = 0; i < 90; i++) {
          state.stardust.push({
            x: state.hash(i * 5.3) * W,
            y: state.hash(i * 13.1) * state.skyHeight,
            r: 0.5 + state.hash(i * 17.9) * 1.4,
            baseAlpha: 0.15 + state.hash(i * 31.3) * 0.45,
            driftRate: 0.5 + state.hash(i * 41.7) * 1.2,
            harmonicK: Math.max(1, Math.round((0.8 + state.hash(i * 7.9) * 2.2) / baseFreq))
          });
        }

        state.bgWarpLines = [];
        for (let i = 0; i < 36; i++) {
          state.bgWarpLines.push({
            x: state.hash(i * 7.7) * W,
            yStartRatio: state.hash(i * 19.1),
            lenRatio: 0.15 + state.hash(i * 23.3) * 0.45,
            thickness: 0.8 + state.hash(i * 37.1) * 2.2,
            baseAlpha: 0.2 + state.hash(i * 43.9) * 0.5,
            phase: state.hash(i * 11.3) * Math.PI * 2
          });
        }

        state.preDropSparkles = [];
        for (let i = 0; i < 150; i++) {
          state.preDropSparkles.push({
            x: state.hash(i * 9.1) * W,
            yStartRatio: state.hash(i * 17.3),
            speed: 0.5 + state.hash(i * 29.7) * 1.6,
            r: 0.8 + state.hash(i * 31.9) * 2.4,
            streakLen: 12 + state.hash(i * 47.1) * 36,
            alpha: 0.3 + state.hash(i * 53.3) * 0.6,
            phase: state.hash(i * 13.7) * Math.PI * 2
          });
        }

        // star seeds for midi notes
        state.starSeeds = [];
        const allNotes = project.midi ? project.midi.allNotes : [];
        let minPitch = 127;
        let maxPitch = 0;
        for (const n of allNotes) {
          if (n.pitch < minPitch) minPitch = n.pitch;
          if (n.pitch > maxPitch) maxPitch = n.pitch;
        }
        if (minPitch >= maxPitch) { minPitch = 48; maxPitch = 84; }
        state.minPitch = minPitch;
        state.maxPitch = maxPitch;

        const pitchSpan = Math.max(12, maxPitch - minPitch);
        for (let idx = 0; idx < allNotes.length; idx++) {
          const n = allNotes[idx];
          const pitchNorm = (n.pitch - minPitch) / pitchSpan;
          const xNorm = 0.12 + 0.76 * (state.hash(idx * 7.13 + n.pitch * 3.7) * 0.6 + pitchNorm * 0.4);
          const yNorm = 0.15 + 0.65 * (1.0 - pitchNorm);

          state.starSeeds.push({
            note: n,
            origX: xNorm * W,
            origY: state.skyTop + yNorm * (state.skyHeight - state.skyTop),
            x: xNorm * W,
            y: state.skyTop + yNorm * (state.skyHeight - state.skyTop),
            radius: 4.5 + (n.velocity || 0.8) * 4.5,
            warmth: state.hash(idx * 13.9 + n.pitch),
            pitchNorm
          });
        }

        state.saliencyCanvas = null;
        state.saliencyCtx = null;
      `,

      drawScript: `
        const controls = frame.controls || {};
        const project = state.project || {};
        const tCurrent = frame.audio.time;
        const dur = frame.audio.duration || 30.0;
        const dropTime = (state.dropTime !== undefined && state.dropTime !== null)
          ? state.dropTime
          : (project.dropTime !== undefined && project.dropTime !== null ? project.dropTime : dur * 0.5);
        const isPostDrop = tCurrent >= dropTime;
        const dropAge = isPostDrop ? tCurrent - dropTime : -1;
        const energy = frame.audio.rms || 0.5;

        const bloom = controls.bloomIntensity !== undefined ? controls.bloomIntensity : 0.88;
        const animeOp = controls.animeOpacity !== undefined ? controls.animeOpacity : 0.62;
        const motionMult = controls.cameraMotion !== undefined ? controls.cameraMotion : 1.0;

        // camera sway & pre-drop lift
        const pLift = (!isPostDrop && tCurrent >= dropTime - 2.2 && tCurrent < dropTime)
          ? Math.max(0, Math.min(1, (tCurrent - (dropTime - 2.2)) / 2.2)) : 0;
        const liftEase = pLift * pLift * (3 - 2 * pLift);

        let camX = Math.sin(tCurrent * 0.4) * 3.0 * motionMult;
        let camY = Math.cos(tCurrent * 0.35) * 2.5 * motionMult;
        if (pLift > 0.01) {
          camY -= (pLift * 8 + liftEase * 48) * motionMult;
          camX += (Math.sin(tCurrent * 38) * 3.0) * Math.pow(pLift, 2.5) * motionMult;
        }
        if (isPostDrop && dropAge < 0.38) {
          const punch = Math.pow(1 - dropAge / 0.38, 2.2);
          camX += Math.sin(dropAge * 68) * 8.0 * punch * motionMult;
          camY += Math.cos(dropAge * 74) * 7.0 * punch * motionMult;
        }

        ctx.save();
        if (motionMult > 0.01) {
          ctx.translate(width * 0.5 + camX, height * 0.5 + camY);
          ctx.translate(-width * 0.5, -height * 0.5);
        }

        // anime video layer after drop
        if (isPostDrop && animeOp > 0.01) {
          ctx.save();
          let vidAlpha = Math.min(1.0, dropAge / 0.35) * animeOp;
          ctx.globalAlpha = vidAlpha;

          const clipIdx = 0;
          frame.clips.drawClip(ctx, clipIdx, 0, 0, width, height, { opacity: vidAlpha });

          const vig = ctx.createLinearGradient(0, 0, 0, height);
          vig.addColorStop(0, 'rgba(18, 24, 41, 0.45)');
          vig.addColorStop(0.3, 'rgba(18, 24, 41, 0.1)');
          vig.addColorStop(0.7, 'rgba(18, 24, 41, 0.15)');
          vig.addColorStop(1, 'rgba(18, 24, 41, 0.85)');
          ctx.fillStyle = vig;
          ctx.fillRect(0, 0, width, height);
          ctx.restore();
        }

        // constellations & starbursts
        const stars = state.starSeeds || [];
        const linkDist = controls.linkDistance || 240;

        for (let i = 0; i < stars.length; i++) {
          const s = stars[i];
          const dt = tCurrent - s.note.startTime;
          const isActive = dt >= 0 && dt <= s.note.duration;
          const isTrigger = dt >= 0 && dt < 0.55;

          if (isActive || isTrigger) {
            const env = isTrigger ? 1.0 - (dt / 0.55) : 0.8;
            const starAlpha = Math.min(1.0, env * bloom);

            ctx.save();
            ctx.strokeStyle = s.warmth > 0.5 ? \`rgba(255, 235, 195, \${starAlpha})\` : \`rgba(195, 235, 255, \${starAlpha})\`;
            ctx.lineWidth = 1.5;

            const rayLen = (18 + s.radius * 3.5) * (0.8 + env * 0.8);
            ctx.beginPath();
            ctx.moveTo(s.x - rayLen, s.y);
            ctx.lineTo(s.x + rayLen, s.y);
            ctx.moveTo(s.x, s.y - rayLen);
            ctx.lineTo(s.x, s.y + rayLen);
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(s.x, s.y, s.radius * (0.8 + env * 0.6), 0, Math.PI * 2);
            ctx.fillStyle = \`rgba(255, 255, 255, \${starAlpha})\`;
            ctx.fill();
            ctx.restore();

            for (let j = i + 1; j < stars.length; j++) {
              const s2 = stars[j];
              const dt2 = tCurrent - s2.note.startTime;
              if (dt2 >= 0 && dt2 <= s2.note.duration) {
                const dist = Math.hypot(s.x - s2.x, s.y - s2.y);
                if (dist < linkDist) {
                  const lineAlpha = (1 - dist / linkDist) * 0.45 * starAlpha;
                  ctx.strokeStyle = \`rgba(185, 209, 187, \${lineAlpha})\`;
                  ctx.lineWidth = 1.2;
                  ctx.beginPath();
                  ctx.moveTo(s.x, s.y);
                  ctx.lineTo(s2.x, s2.y);
                  ctx.stroke();
                }
              }
            }
          }
        }

        // drop flash
        if (isPostDrop && dropAge >= 0 && dropAge < 0.8) {
          const flash = Math.pow(1 - dropAge / 0.8, 2.5);
          ctx.fillStyle = \`rgba(255, 255, 255, \${flash * 0.45})\`;
          ctx.fillRect(0, 0, width, height);
        }

        ctx.restore();

        // bottom piano roll
        const rollTop = state.pianoRollTop || Math.round(height * 0.724);
        const rollH = height - rollTop;

        ctx.save();
        const rollGrad = ctx.createLinearGradient(0, rollTop, 0, height);
        rollGrad.addColorStop(0, 'rgba(18, 24, 41, 0.45)');
        rollGrad.addColorStop(0.3, 'rgba(22, 33, 78, 0.7)');
        rollGrad.addColorStop(1, 'rgba(18, 24, 41, 0.95)');
        ctx.fillStyle = rollGrad;
        ctx.fillRect(0, rollTop, width, rollH);

        ctx.strokeStyle = 'rgba(216, 230, 219, 0.22)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, rollTop);
        ctx.lineTo(width, rollTop);
        ctx.stroke();

        const rollLeft = 40;
        const rollWidth = width - 80;
        const pSpan = Math.max(12, state.maxPitch - state.minPitch);
        const timeWindow = 4.5;

        for (const n of frame.midi.allNotes) {
          const noteT = n.startTime;
          if (noteT < tCurrent - 0.5 || noteT > tCurrent + timeWindow) continue;

          const x = rollLeft + ((noteT - tCurrent) / timeWindow) * rollWidth;
          const pNorm = (n.pitch - state.minPitch) / pSpan;
          const y = rollTop + 20 + (1.0 - pNorm) * (rollH - 50);
          const barW = Math.max(8, (n.duration / timeWindow) * rollWidth);

          const isPlaying = tCurrent >= n.startTime && tCurrent <= n.startTime + n.duration;
          ctx.fillStyle = isPlaying ? '#83ca90' : 'rgba(94, 138, 125, 0.65)';
          ctx.fillRect(x, y, barW, 4);

          if (isPlaying) {
            ctx.fillStyle = '#f0f7f2';
            ctx.beginPath();
            ctx.arc(x, y + 2, 4, 0, Math.PI * 2);
            ctx.fill();
          }
        }

        ctx.strokeStyle = '#83ca90';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(rollLeft, rollTop);
        ctx.lineTo(rollLeft, height);
        ctx.stroke();

        ctx.textAlign = 'center';
        ctx.font = '500 24px "Space Grotesk", sans-serif';
        ctx.fillStyle = '#f0f7f2';
        const numPart = project.sampleNumber ? \`#\${project.sampleNumber} · \` : '';
        const titlePart = project.title || 'untitled';
        ctx.fillText(\`[\${numPart}\${titlePart}]\`, width * 0.5, rollTop - 34);

        ctx.font = '400 16px "IBM Plex Mono", monospace';
        ctx.fillStyle = '#9daea8';
        const metaList = [
          project.bpm ? \`\${project.bpm} BPM\` : null,
          project.key ? project.key.toUpperCase() : null,
          project.brand || null
        ].filter(Boolean);
        if (metaList.length > 0) {
          ctx.fillText(metaList.join(' · '), width * 0.5, rollTop - 12);
        }

        ctx.restore();
      `
    },

    controlsBox: {
      fields: [
        {
          id: 'timeOfDay',
          target: 'shader_uniform',
          label: 'Sky Palette',
          type: 'slider',
          defaultValue: 25,
          min: 0,
          max: 100,
          step: 1
        },
        {
          id: 'sunsetDropTransition',
          target: 'shader_uniform',
          label: 'Sunset Drop Transition',
          type: 'toggle',
          defaultValue: false
        },
        {
          id: 'driftSpeed',
          target: 'overlay_control',
          label: 'Star Drift Speed',
          type: 'slider',
          defaultValue: 1.0,
          min: 0.2,
          max: 3.0,
          step: 0.1
        },
        {
          id: 'linkDistance',
          target: 'overlay_control',
          label: 'Constellation Span',
          type: 'slider',
          defaultValue: 240,
          min: 80,
          max: 450,
          step: 10
        },
        {
          id: 'bloomIntensity',
          target: 'both',
          label: 'Star Bloom',
          type: 'slider',
          defaultValue: 0.88,
          min: 0.2,
          max: 1.5,
          step: 0.05
        },
        {
          id: 'animeOpacity',
          target: 'overlay_control',
          label: 'Clip Blend Opacity',
          type: 'slider',
          defaultValue: 0.62,
          min: 0.1,
          max: 1.0,
          step: 0.02
        },
        {
          id: 'cameraMotion',
          target: 'overlay_control',
          label: 'Camera Motion',
          type: 'slider',
          defaultValue: 1.0,
          min: 0.0,
          max: 2.0,
          step: 0.1
        },
        {
          id: 'cutMode',
          target: 'overlay_control',
          label: 'Drop Cut Mode',
          type: 'select',
          defaultValue: 'chord',
          options: ['chord', 'single', '2bar', '4bar', 'impact']
        },
        {
          id: 'speedRamping',
          target: 'overlay_control',
          label: 'Speed Ramp Cuts',
          type: 'toggle',
          defaultValue: true
        },
        {
          id: 'dropGlitch',
          target: 'overlay_control',
          label: 'Glitch Transitions',
          type: 'toggle',
          defaultValue: true
        },
        {
          id: 'autoFrame',
          target: 'overlay_control',
          label: 'Auto-Frame Subject',
          type: 'toggle',
          defaultValue: true
        }
      ],
      values: {
        timeOfDay: 25,
        sunsetDropTransition: false,
        driftSpeed: 1.0,
        linkDistance: 240,
        bloomIntensity: 0.88,
        animeOpacity: 0.62,
        cameraMotion: 1.0,
        cutMode: 'chord',
        speedRamping: true,
        dropGlitch: true,
        autoFrame: true
      }
    }
  };

  const CINEMATIC_MINIMAL_PRESET = {
    version: '1.0',
    id: 'cinematic-minimal',
    meta: {
      name: 'Cinematic Minimal',
      title: 'Cinematic Minimal',
      description: 'Anamorphic matte bars, audio spectrum, and 35mm grain',
      aspectRatio: '9:16',
      badge: 'Aesthetic'
    },

    shaderBox: {
      fragmentShader: `
        precision mediump float;
        varying vec2 v_uv;
        uniform vec2 u_resolution;
        uniform float u_time;
        uniform float u_bass;
        uniform float u_rms;
        uniform float filmGrain;

        float random(vec2 p) {
          return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
        }

        void main() {
          vec2 uv = v_uv;
          vec3 col = vec3(0.06, 0.08, 0.12);

          // subtle scanline / film grain
          float grain = (random(uv * 120.0 + fract(u_time * 1.5)) - 0.5) * (0.08 + filmGrain * 0.12);
          col += grain;

          // bass vignette pulse
          float dist = distance(uv, vec2(0.5));
          col *= 1.0 - dist * (0.45 + u_bass * 0.15);

          gl_FragColor = vec4(col, 1.0);
        }
      `
    },

    frontUiBox: {
      initScript: `
        state.project = project;
        state.particles = [];
        const W = project.aspectRatio === '16:9' ? 1920 : 1080;
        const H = project.aspectRatio === '16:9' ? 1080 : 1920;

        for (let i = 0; i < 40; i++) {
          state.particles.push({
            x: Math.random() * W,
            y: Math.random() * H,
            vx: (Math.random() - 0.5) * 8,
            vy: -Math.random() * 12 - 4,
            r: Math.random() * 2.2 + 0.8,
            alpha: Math.random() * 0.4 + 0.15,
            phase: Math.random() * Math.PI * 2
          });
        }
      `,

      drawScript: `
        const controls = frame.controls || {};
        const project = state.project || {};
        const t = frame.audio.time;
        const dur = frame.audio.duration || 29.09;
        const barH = controls.letterboxHeight !== undefined ? controls.letterboxHeight : 200;
        const accent = controls.accentColor || '#38bdf8';

        const viewY = barH;
        const viewH = height - barH * 2;
        frame.clips.drawClip(ctx, 0, 0, viewY, width, viewH, { opacity: 0.88 });

        ctx.fillStyle = '#0a0d14';
        ctx.fillRect(0, 0, width, barH);
        ctx.fillRect(0, height - barH, width, barH);

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, barH);
        ctx.lineTo(width, barH);
        ctx.moveTo(0, height - barH);
        ctx.lineTo(width, height - barH);
        ctx.stroke();

        // top telemetry hud
        ctx.save();
        ctx.font = '500 18px "IBM Plex Mono", monospace';
        ctx.fillStyle = accent;
        ctx.fillRect(60, barH * 0.5 - 6, 4, 14);
        ctx.fillStyle = '#f0f7f2';
        ctx.fillText('35MM // 24FPS', 74, barH * 0.5 + 6);

        const mins = String(Math.floor(t / 60)).padStart(2, '0');
        const secs = String(Math.floor(t % 60)).padStart(2, '0');
        const frames = String(Math.floor((t % 1) * 60)).padStart(2, '0');
        ctx.textAlign = 'right';
        ctx.fillText(\`\${mins}:\${secs}:\${frames}\`, width - 60, barH * 0.5 + 6);
        ctx.restore();

        // audio spectrum bars above bottom bar
        ctx.save();
        const numBars = 48;
        const specW = width - 120;
        const barWidth = (specW / numBars) * 0.65;
        const startX = 60;
        const baseY = height - barH - 24;

        for (let i = 0; i < numBars; i++) {
          const energy = frame.audio.rms * (Math.sin(t * 8 + i * 0.4) * 0.5 + 0.5);
          const barHeight = Math.max(4, energy * 90);

          ctx.fillStyle = accent;
          ctx.fillRect(startX + i * (specW / numBars), baseY - barHeight, barWidth, barHeight);
        }
        ctx.restore();

        // bottom bar typography
        ctx.save();
        ctx.textAlign = 'left';
        ctx.font = '600 22px "Space Grotesk", sans-serif';
        ctx.fillStyle = '#f0f7f2';
        ctx.fillText(\`\${(project.title || 'untitled').toUpperCase()}\`, 60, height - barH * 0.5 + 8);

        ctx.textAlign = 'right';
        ctx.font = '400 16px "IBM Plex Mono", monospace';
        ctx.fillStyle = '#9daea8';
        const rightMeta = [
          project.bpm ? \`\${project.bpm}BPM\` : null,
          project.key ? project.key.toUpperCase() : null
        ].filter(Boolean).join(' // ');
        if (rightMeta) {
          ctx.fillText(rightMeta, width - 60, height - barH * 0.5 + 8);
        }
        ctx.restore();
      `
    },

    controlsBox: {
      fields: [
        {
          id: 'letterboxHeight',
          target: 'overlay_control',
          label: 'Letterbox Height',
          type: 'slider',
          defaultValue: 200,
          min: 80,
          max: 420,
          step: 10
        },
        {
          id: 'filmGrain',
          target: 'shader_uniform',
          label: '35mm Film Grain',
          type: 'slider',
          defaultValue: 0.35,
          min: 0.0,
          max: 1.0,
          step: 0.05
        },
        {
          id: 'accentColor',
          target: 'both',
          label: 'HUD Accent Color',
          type: 'color',
          defaultValue: '#38bdf8'
        },
        {
          id: 'bloomIntensity',
          target: 'overlay_control',
          label: 'Spectrum Glow',
          type: 'slider',
          defaultValue: 0.75,
          min: 0.1,
          max: 1.5,
          step: 0.05
        },
        {
          id: 'cutMode',
          target: 'overlay_control',
          label: 'Cut Mode',
          type: 'select',
          defaultValue: 'chord',
          options: ['chord', 'single', '2bar', '4bar', 'impact']
        }
      ],
      values: {
        letterboxHeight: 200,
        filmGrain: 0.35,
        accentColor: '#38bdf8',
        bloomIntensity: 0.75,
        cutMode: 'chord'
      }
    }
  };

  const ANIME_CHORD_FLOW_PRESET = {
    version: '1.0',
    id: 'anime-chord-flow',
    meta: {
      name: 'Anime Chord Flow',
      title: 'Anime Chord Flow',
      description: 'Chord-synced clip cuts, chromatic aberration, and bar/beat HUD',
      aspectRatio: '9:16',
      badge: 'Dynamic'
    },

    shaderBox: {
      fragmentShader: `
        precision mediump float;
        varying vec2 v_uv;
        uniform vec2 u_resolution;
        uniform float u_time;
        uniform float u_bass;
        uniform float u_note_hit;
        uniform sampler2D u_video_tex;
        uniform float u_has_video;
        uniform float glitchIntensity;
        uniform float bassPulse;

        void main() {
          vec2 uv = v_uv;

          // bass pulse zoom
          vec2 center = vec2(0.5);
          float zoom = 1.0 - (u_bass * 0.035 * bassPulse);
          uv = (uv - center) * zoom + center;

          // chromatic aberration glitch on chord trigger
          float glitch = u_note_hit * glitchIntensity * 0.015;
          vec4 col;
          if (u_has_video > 0.5) {
            float r = texture2D(u_video_tex, uv + vec2(glitch, 0.0)).r;
            float g = texture2D(u_video_tex, uv).g;
            float b = texture2D(u_video_tex, uv - vec2(glitch, 0.0)).b;
            col = vec4(r, g, b, 1.0);
          } else {
            col = vec4(0.08, 0.11, 0.18, 1.0);
          }

          // filmic edge vignette
          float vig = 1.0 - distance(v_uv, vec2(0.5)) * 0.6;
          col.rgb *= vig;

          gl_FragColor = col;
        }
      `
    },

    frontUiBox: {
      initScript: `
        state.project = project;
        state.chordNames = (project && project.chords && project.chords.length) ? project.chords : [];
        state.currentChordIdx = 0;
      `,

      drawScript: `
        const controls = frame.controls || {};
        const project = state.project || {};
        const t = frame.audio.time;
        const dur = frame.audio.duration || 30.0;
        const bpm = project.bpm || 120;
        const secPerBeat = 60 / bpm;
        const barSec = secPerBeat * 4;

        // current bar & beat
        const currentBar = Math.floor(t / barSec) + 1;
        const currentBeat = Math.floor((t % barSec) / secPerBeat) + 1;

        // overlay kinetic hud
        ctx.save();

        ctx.font = '600 36px "Space Grotesk", sans-serif';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'left';
        ctx.fillText(\`BAR \${String(currentBar).padStart(2, '0')}.\${currentBeat}\`, 60, 120);

        const subMeta = [
          project.key ? project.key.toUpperCase() : null,
          project.bpm ? \`\${project.bpm} BPM\` : null
        ].filter(Boolean).join(' · ');
        if (subMeta) {
          ctx.font = '400 18px "IBM Plex Mono", monospace';
          ctx.fillStyle = '#83ca90';
          ctx.fillText(subMeta, 60, 155);
        }

        const cuts = project.chordCutTimes || [];
        let chordIdx = -1;
        for (let i = cuts.length - 1; i >= 0; i--) {
          if (t >= cuts[i]) {
            chordIdx = i;
            break;
          }
        }

        let chordDisplay = '';
        if (state.chordNames && state.chordNames.length > 0 && chordIdx >= 0) {
          chordDisplay = state.chordNames[chordIdx % state.chordNames.length];
        } else if (frame.midi && frame.midi.activeNotes && frame.midi.activeNotes.length > 0) {
          const names = Array.from(new Set(frame.midi.activeNotes.map((n) => (n.name || 'note').replace(/\\d+$/, ''))));
          chordDisplay = names.slice(0, 4).join(' ');
        } else if (chordIdx >= 0) {
          chordDisplay = \`CHORD \${chordIdx + 1}\`;
        }

        if (chordDisplay) {
          ctx.textAlign = 'right';
          ctx.font = '500 24px "IBM Plex Mono", monospace';
          ctx.fillStyle = '#f0f7f2';
          ctx.fillText(chordDisplay.toUpperCase(), width - 60, 120);
        }

        const beatFrac = (t % secPerBeat) / secPerBeat;
        const ringAlpha = (1 - beatFrac) * 0.45;
        const ringRadius = 12 + beatFrac * 28;

        ctx.strokeStyle = \`rgba(131, 202, 144, \${ringAlpha})\`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(width - 60, 195, ringRadius, 0, Math.PI * 2);
        ctx.stroke();

        ctx.restore();
      `
    },

    controlsBox: {
      fields: [
        {
          id: 'glitchIntensity',
          target: 'shader_uniform',
          label: 'Chord Cut Glitch',
          type: 'slider',
          defaultValue: 1.0,
          min: 0.0,
          max: 3.0,
          step: 0.1
        },
        {
          id: 'bassPulse',
          target: 'shader_uniform',
          label: 'Bass Pulse Zoom',
          type: 'slider',
          defaultValue: 1.0,
          min: 0.0,
          max: 2.5,
          step: 0.1
        },
        {
          id: 'cutMode',
          target: 'overlay_control',
          label: 'Clip Cut Mode',
          type: 'select',
          defaultValue: 'chord',
          options: ['chord', 'single', '2bar', '4bar', 'impact']
        },
        {
          id: 'speedRamping',
          target: 'overlay_control',
          label: 'Speed Ramp Cuts',
          type: 'toggle',
          defaultValue: true
        }
      ],
      values: {
        glitchIntensity: 1.0,
        bassPulse: 1.0,
        cutMode: 'chord',
        speedRamping: true
      }
    }
  };

  window.STARTER_PRESETS = {
    'anime-chord-flow': ANIME_CHORD_FLOW_PRESET
  };
  window.STARTER_PRESET_DEFINITIONS = {
    constellations: CONSTELLATIONS_PRESET,
    'cinematic-minimal': CINEMATIC_MINIMAL_PRESET,
    'anime-chord-flow': ANIME_CHORD_FLOW_PRESET
  };
})();
