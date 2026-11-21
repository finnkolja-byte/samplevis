// reusable deterministic camera, easing, speed-ramp, motion-blur, and glitch primitives
(function () {
  'use strict';

  function clamp01(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return n < 0 ? 0 : n > 1 ? 1 : n;
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function hash(n) {
    const s = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
    return s - Math.floor(s);
  }

  const EASE_CURVES = {
    linear: (t) => t,
    smooth: (t) => t * t * (3 - 2 * t),
    smoothstep: (t) => t * t * (3 - 2 * t),
    smoother: (t) => t * t * t * (t * (t * 6 - 15) + 10),
    smootherstep: (t) => t * t * t * (t * (t * 6 - 15) + 10),
    quadIn: (t) => t * t,
    quadOut: (t) => 1 - (1 - t) * (1 - t),
    cubicIn: (t) => t * t * t,
    cubicOut: (t) => 1 - Math.pow(1 - t, 3),
    cubicInOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    expoOut: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
    backOut: (t) => {
      const c1 = 1.70158;
      const c3 = c1 + 1;
      return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    },
    // weightless float followed by exponential acceleration into a drop
    anticipation: (t) => 0.06 * Math.pow(t, 1.6) + 0.94 * Math.pow(t, 4.8),
    whip: (t) => 0.28 * Math.pow(t, 2) + 0.72 * Math.pow(t, 4)
  };

  function ease(p, kind = 'smooth') {
    const t = clamp01(p);
    const fn = EASE_CURVES[kind] || EASE_CURVES.smooth;
    return fn(t);
  }

  function impulse(age, dur = 0.38, power = 2.2) {
    if (!Number.isFinite(age) || age < 0 || !Number.isFinite(dur) || dur <= 0 || age >= dur) {
      return 0;
    }
    return Math.pow(Math.max(0, 1 - age / dur), power);
  }

  function transition(time, startTime, dur = 0.6, kind = 'smoother') {
    const t = Number(time) || 0;
    const st = Number(startTime) || 0;
    const p = dur <= 0 ? (t >= st ? 1 : 0) : clamp01((t - st) / dur);
    const eased = ease(p, kind);
    return {
      active: t >= st && p < 1,
      started: t >= st,
      finished: p >= 1,
      p,
      eased,
      inverse: 1 - eased
    };
  }

  function preDrop(time, dropTime, dur = 2.2) {
    const t = Number(time) || 0;
    const dt = Number.isFinite(dropTime) ? dropTime : 15;
    const safeDur = Math.max(0.1, Number(dur) || 2.2);
    const windowStart = dt - safeDur;

    if (t >= windowStart && t < dt) {
      const p = clamp01((t - windowStart) / safeDur);
      return {
        active: true,
        p,
        lift: EASE_CURVES.anticipation(p),
        tension: Math.pow(p, 2.8),
        dur: safeDur
      };
    }
    return { active: false, p: 0, lift: 0, tension: 0, dur: safeDur };
  }

  function resolveDropTime(project) {
    const dur = Number(project?.duration) || 30.0;
    return typeof project?.dropTime === 'number' && Number.isFinite(project.dropTime)
      ? project.dropTime
      : dur * 0.5;
  }

  function _computeRawCamera(t, dropTime, audioMetrics, cfg) {
    const isPostDrop = t >= dropTime;
    const dropAge = isPostDrop ? t - dropTime : -1;
    const liftInfo = preDrop(t, dropTime, cfg.preDropDur);
    const dropBlend = isPostDrop ? 1.0 : (liftInfo.active ? Math.pow(liftInfo.p, 1.8) : 0.0);

    const swayIntroX = Math.sin(t * 0.20) * 3.2 + Math.sin(t * 0.44) * 1.2;
    const swayIntroY = Math.cos(t * 0.16) * 2.6 + Math.cos(t * 0.38) * 1.0;
    const jitterIntroX = Math.sin(t * 3.2) * 0.12;
    const jitterIntroY = Math.cos(t * 3.8) * 0.12;
    const rotIntro = Math.sin(t * 0.14) * 0.0010;

    const swayDropX = Math.sin(t * 0.52) * 3.6 + Math.sin(t * 1.3) * 1.6;
    const swayDropY = Math.cos(t * 0.46) * 3.0 + Math.cos(t * 1.15) * 1.4;
    const jitterDropX = (Math.sin(t * 14.8) + Math.cos(t * 22.3)) * 0.42;
    const jitterDropY = (Math.cos(t * 16.4) + Math.sin(t * 20.8)) * 0.42;
    const rotDrop = Math.sin(t * 0.35) * 0.0016 + Math.cos(t * 8.5) * 0.0003;

    const swayX = lerp(swayIntroX, swayDropX, dropBlend);
    const swayY = lerp(swayIntroY, swayDropY, dropBlend);
    const jitterX = lerp(jitterIntroX, jitterDropX, dropBlend);
    const jitterY = lerp(jitterIntroY, jitterDropY, dropBlend);
    const baseRot = lerp(rotIntro, rotDrop, dropBlend);

    let tensionX = 0;
    let tensionY = 0;
    let tensionRot = 0;
    if (liftInfo.active) {
      tensionX = (Math.sin(t * 42) * 2.4 + Math.cos(t * 68) * 1.6) * liftInfo.tension * 7.0 * cfg.shake;
      tensionY = -(liftInfo.p * 10 + liftInfo.lift * 72) * cfg.liftScale +
        (Math.cos(t * 46) * 2.8 + Math.sin(t * 76) * 1.8) * liftInfo.tension * 7.0 * cfg.shake;
      tensionRot = Math.sin(t * 32) * 0.0038 * liftInfo.tension * cfg.shake;
    }

    let impactX = 0;
    let impactY = 0;
    const punchEnv = impulse(dropAge, 0.38, 2.2);
    if (punchEnv > 0) {
      impactX = Math.sin(dropAge * 68) * 8.5 * punchEnv * cfg.dropPunch;
      impactY = Math.cos(dropAge * 74) * 7.5 * punchEnv * cfg.dropPunch;
    }

    let beatX = 0;
    let beatY = 0;
    if (cfg.beatShake > 0.001 && audioMetrics) {
      const kick = Math.max(0, Number(audioMetrics.beatImpulse) || 0, (Number(audioMetrics.bass) || 0) * 0.55);
      beatX = Math.sin(t * 48) * 4.2 * kick * cfg.beatShake;
      beatY = Math.cos(t * 54) * 3.8 * kick * cfg.beatShake;
    }

    const shakeX = (tensionX + impactX + beatX) * cfg.motion;
    const shakeY = ((liftInfo.active ? tensionY + (liftInfo.p * 10 + liftInfo.lift * 72) * cfg.liftScale : 0) + impactY + beatY) * cfg.motion;
    const zoom = cfg.zoomBase + cfg.zoomDrop * dropBlend + impulse(dropAge, 0.45, 2.0) * 0.025 * cfg.dropPunch;

    return {
      x: (swayX + jitterX + tensionX + impactX + beatX) * cfg.motion,
      y: (swayY + jitterY + tensionY + impactY + beatY) * cfg.motion,
      rot: (baseRot + tensionRot) * cfg.motion,
      zoom,
      shakeX,
      shakeY,
      liftInfo
    };
  }

  function camera(time, project, audioMetrics, loopInfo, opts = {}) {
    const t = Number(time) || 0;
    const dropTime = Number.isFinite(opts.dropTime) ? opts.dropTime : resolveDropTime(project);
    const cfg = {
      motion: opts.motion !== undefined ? Math.max(0, Number(opts.motion)) : 1.0,
      shake: opts.shake !== undefined ? Math.max(0, Number(opts.shake)) : 1.0,
      dropPunch: opts.dropPunch !== undefined ? Math.max(0, Number(opts.dropPunch)) : 1.0,
      beatShake: opts.beatShake !== undefined ? Math.max(0, Number(opts.beatShake)) : 0.0,
      liftScale: opts.liftScale !== undefined ? Math.max(0, Number(opts.liftScale)) : 1.0,
      preDropDur: opts.preDropDur !== undefined ? Math.max(0.2, Number(opts.preDropDur)) : 2.2,
      zoomBase: opts.zoomBase !== undefined ? Number(opts.zoomBase) : 1.0,
      zoomDrop: opts.zoomDrop !== undefined ? Number(opts.zoomDrop) : 0.0,
      loopBack: opts.loopBack !== false
    };

    if (cfg.motion <= 0.005) {
      const liftInfo = preDrop(t, dropTime, cfg.preDropDur);
      return {
        x: 0,
        y: 0,
        rot: 0,
        zoom: cfg.zoomBase,
        shakeX: 0,
        shakeY: 0,
        isLifting: liftInfo.active,
        pLift: liftInfo.p,
        liftEase: liftInfo.lift,
        apply() { }
      };
    }

    const cur = _computeRawCamera(t, dropTime, audioMetrics, cfg);
    let camX = cur.x;
    let camY = cur.y;
    let camRot = cur.rot;
    let camZoom = cur.zoom;
    let shakeX = cur.shakeX;
    let shakeY = cur.shakeY;

    if (cfg.loopBack && loopInfo?.inTransition) {
      const p0 = _computeRawCamera(0, dropTime, null, cfg);
      const easeP = ease(loopInfo.progress, 'smooth');
      camX = lerp(camX, p0.x, easeP);
      camY = lerp(camY, p0.y, easeP);
      camRot = lerp(camRot, p0.rot, easeP);
      camZoom = lerp(camZoom, p0.zoom, easeP);
      shakeX = lerp(shakeX, 0, easeP);
      shakeY = lerp(shakeY, 0, easeP);
    }

    return {
      x: camX,
      y: camY,
      rot: camRot,
      zoom: camZoom,
      shakeX,
      shakeY,
      isLifting: cur.liftInfo.active,
      pLift: cur.liftInfo.p,
      liftEase: cur.liftInfo.lift,
      apply(destCtx, width, height, parallax = 1.0) {
        if (!destCtx) return;
        const px = Number(parallax);
        const mult = Number.isFinite(px) ? px : 1.0;
        const scale = lerp(1.0, camZoom, mult);
        destCtx.translate(width * 0.5 + camX * mult, height * 0.5 + camY * mult);
        if (Math.abs(camRot * mult) > 1e-6) {
          destCtx.rotate(camRot * mult);
        }
        if (Math.abs(scale - 1.0) > 1e-5) {
          destCtx.scale(scale, scale);
        }
        destCtx.translate(-width * 0.5, -height * 0.5);
      }
    };
  }

  function resolveCustomCutTimes(project) {
    const dur = Math.max(0.5, Number(project?.duration) || 30.0);
    const catId = typeof project?._customCutCategory === 'string' ? project._customCutCategory.trim() : '';
    let raw = null;
    if (catId && Array.isArray(project?._customCues?.[catId])) {
      raw = project._customCues[catId].map((c) => Number(c?.time));
    } else if (Array.isArray(project?.customCutTimes)) {
      raw = project.customCutTimes.map((t) => Number(t));
    }
    if (!raw || raw.length === 0) return [];
    const sorted = raw
      .filter((t) => Number.isFinite(t) && t >= 0 && t <= dur)
      .map((t) => Number(t.toFixed(3)))
      .sort((a, b) => a - b);
    const deduped = [];
    for (const t of sorted) {
      if (deduped.length === 0 || t - deduped[deduped.length - 1] >= 0.03) {
        deduped.push(t);
      }
    }
    return deduped;
  }

  function _resolveCutInterval(time, project, cutMode, startAtDrop = true) {
    const dur = Math.max(0.5, Number(project?.duration) || 30.0);
    const dropTime = resolveDropTime(project);
    const anchorTime = startAtDrop ? dropTime : 0;

    if (cutMode === 'single') {
      return { start: anchorTime, end: dur, index: 0 };
    }

    let cuts = [];
    if (cutMode === 'chord' && Array.isArray(project?.chordCutTimes) && project.chordCutTimes.length) {
      cuts = [anchorTime, dropTime, ...project.chordCutTimes.filter((c) => c > anchorTime + 0.05), dur];
    } else if (cutMode === 'impact' && Array.isArray(project?.impactTimes)) {
      const base = project?._impactTimesEdited ? [anchorTime] : [anchorTime, dropTime];
      cuts = [...base, ...project.impactTimes.filter((c) => c > anchorTime + 0.05 && c < dur - 0.02), dur];
    } else if (cutMode === 'custom') {
      const customTimes = resolveCustomCutTimes(project);
      cuts = [anchorTime, ...customTimes.filter((c) => c > anchorTime + 0.05 && c < dur - 0.02), dur];
    } else {
      const bpm = Math.max(20, Number(project?.bpm) || 120);
      const secPerBar = (60 / bpm) * 4;
      const barCount = cutMode === '2bar' ? 2 : 4;
      const step = secPerBar * barCount;
      const anchor = Number.isFinite(project?.downbeatOffset) ? project.downbeatOffset : 0;
      const firstAfterAnchor = anchor >= anchorTime ? anchor : anchor + Math.ceil((anchorTime - anchor) / step) * step;
      cuts.push(anchorTime);
      if (dropTime > anchorTime + 0.05 && dropTime < dur) cuts.push(dropTime);
      for (let ct = firstAfterAnchor; ct < dur; ct += step) cuts.push(ct);
      cuts.push(dur);
    }

    cuts = Array.from(new Set(cuts)).sort((a, b) => a - b);
    if (cuts.length < 2) {
      return { start: anchorTime, end: Math.max(anchorTime + 0.5, dur), index: 0 };
    }

    for (let i = 0; i < cuts.length - 1; i++) {
      if (time >= cuts[i] && time < cuts[i + 1]) {
        return { start: cuts[i], end: cuts[i + 1], index: i };
      }
    }
    return { start: cuts[cuts.length - 2], end: dur, index: Math.max(0, cuts.length - 2) };
  }

  // continuous area-integrated clip timing across slow middle cruise and edge whip ramps
  function getSpeedRampInfo(time, project, opts = {}) {
    const t = Number(time) || 0;
    const speedRamping = opts.speedRamping !== false;
    const startAtDrop = opts.startAtDrop !== false;
    const dur = Math.max(0.5, Number(project?.duration) || 30.0);
    const dropTime = Number.isFinite(opts.dropTime) ? opts.dropTime : resolveDropTime(project);
    const cutMode = opts.cutMode || 'chord';

    if (!speedRamping) {
      const interval = _resolveCutInterval(t, project, cutMode, startAtDrop);
      return {
        clipTime: t,
        instSpeed: 1.0,
        rampFactor: 0,
        isRamping: false,
        phase: 'cruise',
        cutIndex: interval.index || 0,
        cutStart: interval.start,
        cutEnd: interval.end,
        cutAge: Math.max(0, t - interval.start),
        cutProgress: clamp01((t - interval.start) / Math.max(0.25, interval.end - interval.start))
      };
    }

    if (startAtDrop && t < dropTime) {
      return {
        clipTime: 0,
        instSpeed: 1.0,
        rampFactor: 0,
        isRamping: false,
        phase: 'pre-drop',
        cutIndex: 0,
        cutStart: 0,
        cutEnd: dropTime,
        cutAge: t,
        cutProgress: dropTime > 0 ? clamp01(t / dropTime) : 0
      };
    }

    const interval = _resolveCutInterval(t, project, cutMode, startAtDrop);
    const elapsed = Math.max(0, t - interval.start);
    const span = Math.max(0.35, interval.end - interval.start);
    const cutProgress = clamp01(elapsed / span);
    const cutIndex = interval.index || 0;

    const slowSpeed = opts.slowSpeed !== undefined ? Number(opts.slowSpeed) : 0.48;
    const fastSpeed = opts.fastSpeed !== undefined ? Number(opts.fastSpeed) : 2.85;
    const maxRampDur = opts.maxRampDur !== undefined ? Number(opts.maxRampDur) : 0.72;
    const rampDur = Math.min(maxRampDur, span * 0.40);
    const speedDelta = fastSpeed - slowSpeed;

    const c1 = 0.28;
    const c2 = 0.72;
    const areaCoeff = c1 / 3 + c2 / 5;
    const entryArea = slowSpeed * rampDur + speedDelta * rampDur * areaCoeff;

    if (elapsed <= rampDur) {
      const p = (rampDur - elapsed) / rampDur;
      const rampFactor = c1 * Math.pow(p, 2) + c2 * Math.pow(p, 4);
      const instSpeed = slowSpeed + speedDelta * rampFactor;
      const w = rampDur - elapsed;
      const remArea = slowSpeed * w + speedDelta * (
        (c1 * Math.pow(w, 3)) / (3 * rampDur * rampDur) +
        (c2 * Math.pow(w, 5)) / (5 * Math.pow(rampDur, 4))
      );
      return {
        clipTime: entryArea - remArea,
        instSpeed,
        rampFactor,
        isRamping: true,
        phase: 'in',
        cutIndex,
        cutStart: interval.start,
        cutEnd: interval.end,
        cutAge: elapsed,
        cutProgress
      };
    }

    if (elapsed <= span - rampDur) {
      return {
        clipTime: entryArea + slowSpeed * (elapsed - rampDur),
        instSpeed: slowSpeed,
        rampFactor: 0,
        isRamping: false,
        phase: 'cruise',
        cutIndex,
        cutStart: interval.start,
        cutEnd: interval.end,
        cutAge: elapsed,
        cutProgress
      };
    }

    const u = elapsed - (span - rampDur);
    const p = clamp01(u / rampDur);
    const rampFactor = c1 * Math.pow(p, 2) + c2 * Math.pow(p, 4);
    const instSpeed = slowSpeed + speedDelta * rampFactor;
    const midArea = entryArea + slowSpeed * (span - 2 * rampDur);
    const exitIntegral = slowSpeed * u + speedDelta * (
      (c1 * Math.pow(u, 3)) / (3 * rampDur * rampDur) +
      (c2 * Math.pow(u, 5)) / (5 * Math.pow(rampDur, 4))
    );

    return {
      clipTime: midArea + exitIntegral,
      instSpeed,
      rampFactor,
      isRamping: true,
      phase: 'out',
      cutIndex,
      cutStart: interval.start,
      cutEnd: interval.end,
      cutAge: elapsed,
      cutProgress
    };
  }

  // stateless deterministic multi-tap directional and scale shutter blur for 2d canvas
  function shutterBlur(ctx, drawStepFn, opts = {}) {
    if (!ctx || typeof drawStepFn !== 'function') return;
    const dx = Number(opts.dx) || 0;
    const dy = Number(opts.dy) || 0;
    const dScale = Number(opts.dScale) || 0;
    const dRot = Number(opts.dRot) || 0;
    const requestedSamples = Math.max(1, Math.min(12, Math.round(opts.samples || 5)));

    const hasMotion =
      Math.hypot(dx, dy) >= 0.4 ||
      Math.abs(dScale) >= 0.002 ||
      Math.abs(dRot) >= 0.0004;

    if (!hasMotion || requestedSamples <= 1) {
      drawStepFn(0, 1);
      return;
    }

    const trailAlpha = opts.trailAlpha !== undefined ? clamp01(opts.trailAlpha) : 0.72;
    const cx = Number(opts.cx) || 0;
    const cy = Number(opts.cy) || 0;
    const autoTransform = opts.autoTransform !== false;
    const baseAlpha = ctx.globalAlpha;

    // weight head frame strongest while trailing shutter ghosts taper cleanly behind
    const tailBudget = Math.min(0.65, trailAlpha * 0.6);
    const tailCount = requestedSamples - 1;
    let tailWeightSum = 0;
    const tailWeights = new Array(tailCount);
    for (let i = 0; i < tailCount; i++) {
      const frac = (i + 1) / requestedSamples; // 1 = oldest tail
      const w = Math.pow(1 - frac * 0.75, 1.4);
      tailWeights[i] = w;
      tailWeightSum += w;
    }

    for (let i = tailCount - 1; i >= 0; i--) {
      const tNorm = -((i + 1) / tailCount); // -1..0 behind current frame
      const tapWeight = (tailWeights[i] / Math.max(1e-5, tailWeightSum)) * tailBudget;
      ctx.save();
      ctx.globalAlpha = baseAlpha * tapWeight;
      if (autoTransform) {
        if (cx || cy) ctx.translate(cx, cy);
        ctx.translate(dx * tNorm, dy * tNorm);
        if (dRot) ctx.rotate(dRot * tNorm);
        if (dScale) {
          const s = Math.max(0.1, 1 + dScale * tNorm);
          ctx.scale(s, s);
        }
        if (cx || cy) ctx.translate(-cx, -cy);
      }
      drawStepFn(tNorm, tapWeight);
      ctx.restore();
    }

    ctx.save();
    ctx.globalAlpha = baseAlpha * (1 - tailBudget * 0.35);
    drawStepFn(0, 1 - tailBudget * 0.35);
    ctx.restore();
  }

  function streak(ctx, x1, y1, x2, y2, opts = {}) {
    if (!ctx) return;
    if (Math.hypot(x2 - x1, y2 - y1) < 0.5) return;
    const rgb = opts.color || '240, 245, 255';
    const alpha = clamp01(opts.alpha !== undefined ? opts.alpha : 0.5);
    if (alpha <= 0.002) return;

    const grad = ctx.createLinearGradient(x1, y1, x2, y2);
    grad.addColorStop(0, `rgba(${rgb}, ${alpha.toFixed(3)})`);
    grad.addColorStop(0.35, `rgba(${rgb}, ${(alpha * 0.45).toFixed(3)})`);
    grad.addColorStop(1, `rgba(${rgb}, 0)`);

    ctx.save();
    ctx.strokeStyle = grad;
    ctx.lineWidth = Math.max(0.5, Number(opts.width) || 1.5);
    ctx.lineCap = opts.lineCap || 'round';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    const headR = Number(opts.headRadius) || 0;
    if (headR > 0.2) {
      ctx.fillStyle = `rgba(${rgb}, ${Math.min(1, alpha * 1.15).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(x1, y1, headR, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function whipLines(ctx, width, height, intensity, opts = {}) {
    if (!ctx) return;
    const amt = clamp01(intensity);
    const minThresh = opts.minThreshold !== undefined ? opts.minThreshold : 0.05;
    if (amt <= minThresh) return;

    const scaled = (amt - minThresh) / Math.max(1e-5, 1 - minThresh);
    const count = Math.max(1, Math.min(60, Math.round(opts.count || 14)));
    const angle = opts.angle !== undefined ? Number(opts.angle) : 0; // 0 = horizontal whip, -PI/2 = vertical lift
    const dirX = Math.cos(angle);
    const dirY = Math.sin(angle);
    const rgb = opts.color || '235, 244, 255';
    const maxAlpha = (opts.alpha !== undefined ? Number(opts.alpha) : 0.36) * scaled;
    const baseLen = (opts.length !== undefined ? Number(opts.length) : Math.min(width, height) * 0.42) * (0.45 + scaled * 0.85);
    const seedOffset = Number(opts.seed) || 0;
    const travel = (Number(opts.time) || 0) * (opts.speed !== undefined ? Number(opts.speed) : 720);

    ctx.save();
    for (let i = 0; i < count; i++) {
      const h1 = hash(i * 19.3 + 2.7 + seedOffset);
      const h2 = hash(i * 13.1 + 5.1 + seedOffset);
      const h3 = hash(i * 7.7 + 9.4 + seedOffset);
      const len = baseLen * (0.45 + h3 * 0.85);

      const rawX = (h2 * (width + len) + dirX * travel * (0.65 + h3 * 0.6));
      const rawY = (h1 * (height + len) + dirY * travel * (0.65 + h3 * 0.6));
      const x1 = (((rawX % (width + len)) + (width + len)) % (width + len)) - len * 0.5;
      const y1 = (((rawY % (height + len)) + (height + len)) % (height + len)) - len * 0.5;
      const x2 = x1 + dirX * len;
      const y2 = y1 + dirY * len;

      const grad = ctx.createLinearGradient(x1, y1, x2, y2);
      grad.addColorStop(0, `rgba(${rgb}, 0)`);
      grad.addColorStop(0.5, `rgba(${rgb}, ${(maxAlpha * (0.65 + h1 * 0.35)).toFixed(3)})`);
      grad.addColorStop(1, `rgba(${rgb}, 0)`);

      ctx.strokeStyle = grad;
      ctx.lineWidth = (opts.lineWidth || 1.0) + h3 * 1.5;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    ctx.restore();
  }

  function glitch(ctx, source, rect, intensity, opts = {}) {
    if (!ctx || !source) return;
    const env = clamp01(intensity);
    if (env <= 0.005) return;

    const swFull = source.videoWidth || source.naturalWidth || source.width || 0;
    const shFull = source.videoHeight || source.naturalHeight || source.height || 0;
    if (!swFull || !shFull) return;

    const x = rect?.x ?? 0;
    const y = rect?.y ?? 0;
    const w = rect?.w ?? ctx.canvas?.width ?? swFull;
    const h = rect?.h ?? ctx.canvas?.height ?? shFull;
    if (w <= 0 || h <= 0) return;

    const stepRate = opts.stepRate !== undefined ? Number(opts.stepRate) : 45;
    const glitchStep = Math.floor((Number(opts.time) || 0) * stepRate + env * 12);
    const rgbShift = (opts.rgbShift !== undefined ? Number(opts.rgbShift) : 6.5) * (0.7 + hash(glitchStep * 7.1) * 0.6) * env;
    const sliceCount = Math.max(0, Math.min(12, Math.round(opts.slices !== undefined ? opts.slices : 4)));
    const fringeA = opts.fringeA || '0, 240, 255';
    const fringeB = opts.fringeB || '255, 45, 120';

    if (rgbShift > 0.4) {
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = 0.26 * env;
      ctx.drawImage(source, 0, 0, swFull, shFull, x + rgbShift, y, w, h);
      ctx.drawImage(source, 0, 0, swFull, shFull, x - rgbShift, y, w, h);
      ctx.restore();
    }

    for (let i = 0; i < sliceCount; i++) {
      const seed = glitchStep * 23.3 + i * 17.1;
      const normY = ((hash(seed + 0.3) * 0.75) + i * 0.2 + 0.04) % 0.86;
      const normH = 0.025 + hash(seed + 1.9) * 0.065;
      const dir = i % 2 === 0 ? 1 : -1;
      const jitterX = dir * (5 + hash(seed + 3.7) * 16) * env;

      const sy = Math.floor(normY * shFull);
      const sh = Math.max(1, Math.min(Math.floor(normH * shFull), shFull - sy));
      const dy = y + (sy / shFull) * h;
      const dh = (sh / shFull) * h;

      ctx.drawImage(source, 0, sy, swFull, sh, x + jitterX, dy, w, dh);

      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      const fringeAlpha = (0.26 * env).toFixed(3);
      ctx.fillStyle = `rgba(${fringeA}, ${fringeAlpha})`;
      ctx.fillRect(x + jitterX - 2, dy, 5, dh);
      ctx.fillStyle = `rgba(${fringeB}, ${fringeAlpha})`;
      ctx.fillRect(x + jitterX + w - 3, dy, 5, dh);
      ctx.restore();
    }

    if (opts.scanlines !== false) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const scanSeed = glitchStep * 41.3;
      const y1 = y + ((hash(scanSeed) * 0.88 + 0.06) % 0.94) * h;
      const y2 = y + ((hash(scanSeed + 8.9) * 0.85 + 0.08) % 0.92) * h;
      ctx.fillStyle = `rgba(200, 245, 255, ${(0.38 * env).toFixed(3)})`;
      ctx.fillRect(x, y1, w, 1.8);
      ctx.fillStyle = `rgba(225, 185, 255, ${(0.28 * env).toFixed(3)})`;
      ctx.fillRect(x, y2, w, 2.2);

      const bandY = y + (hash(scanSeed + 14.5) * 0.7 + 0.15) * h;
      const bandH = 8 + hash(scanSeed + 22.1) * 24;
      ctx.fillStyle = `rgba(255, 255, 255, ${(0.10 * env).toFixed(3)})`;
      ctx.fillRect(x, bandY, w, bandH);
      ctx.restore();
    }
  }

  function detectFocalX(source, scratchState, targetAspect = 9 / 16) {
    if (!source) return 0.5;
    if (source.dataset?.manualFocalX) {
      const manual = parseFloat(source.dataset.manualFocalX);
      if (Number.isFinite(manual)) return Math.max(0.05, Math.min(0.95, manual));
    }

    const srcKey = source.currentSrc || source.src || '';
    const isVideo = source.tagName === 'VIDEO';
    const timeBucket = isVideo ? Math.floor((source.currentTime || 0) * 4) : 0;
    const cached = source._focalCache;
    if (cached && cached.src === srcKey && cached.bucket === timeBucket) {
      return cached.x;
    }

    if (isVideo && source.readyState < 2) return 0.5;
    if (source.tagName === 'IMG' && (!source.complete || !source.naturalWidth)) return 0.5;

    const w = 160;
    const h = 90;
    if (scratchState && !scratchState.canvas) {
      scratchState.canvas = document.createElement('canvas');
      scratchState.canvas.width = w;
      scratchState.canvas.height = h;
      scratchState.ctx = scratchState.canvas.getContext('2d', { willReadFrequently: true });
    }
    const sCtx = scratchState?.ctx;
    if (!sCtx) return 0.5;

    try {
      sCtx.drawImage(source, 0, 0, w, h);
      const data = sCtx.getImageData(0, 0, w, h).data;
      const colScores = new Float32Array(w);

      // estimate perimeter/background color so silhouettes & distinct non-human subjects stand out
      let bgR = 0;
      let bgG = 0;
      let bgB = 0;
      let bgCount = 0;
      for (let px = 0; px < w; px += 4) {
        const topIdx = px * 4;
        const sideL = ((Math.floor(h * 0.25) * w) + (px % 12)) * 4;
        bgR += data[topIdx] + data[sideL];
        bgG += data[topIdx + 1] + data[sideL + 1];
        bgB += data[topIdx + 2] + data[sideL + 2];
        bgCount += 2;
      }
      const meanR = bgR / Math.max(1, bgCount);
      const meanG = bgG / Math.max(1, bgCount);
      const meanB = bgB / Math.max(1, bgCount);

      for (let py = 0; py < h; py++) {
        const yn = py / h;
        // down-weight extreme top sky & bottom margin clutter; favor head/torso/focal band
        const yWeight = yn < 0.08
          ? 0.35
          : (yn <= 0.76 ? 1.0 : Math.max(0.35, 1.0 - (yn - 0.76) * 2.4));
        const rowStart = py * w * 4;

        for (let px = 0; px < w; px++) {
          const idx = rowStart + px * 4;
          const r = data[idx];
          const g = data[idx + 1];
          const b = data[idx + 2];
          const luma = 0.299 * r + 0.587 * g + 0.114 * b;

          // lighting-tolerant YCbCr skin detector across light, tan, brown, and deep tones
          const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
          const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
          const maxCh = Math.max(r, g, b);
          const minCh = Math.min(r, g, b);
          const isSkin = (
            luma > 28 &&
            luma < 245 &&
            (maxCh - minCh) > 10 &&
            r >= g &&
            r > b &&
            cb >= 77 && cb <= 127 &&
            cr >= 133 && cr <= 173
          );

          // full-luma gradient (horizontal + vertical) avoids relying on red channel alone
          let grad = 0;
          if (px > 0 && px < w - 1 && py > 0 && py < h - 1) {
            const idxL = idx - 4;
            const idxR = idx + 4;
            const idxU = idx - w * 4;
            const idxD = idx + w * 4;
            const lL = 0.299 * data[idxL] + 0.587 * data[idxL + 1] + 0.114 * data[idxL + 2];
            const lR = 0.299 * data[idxR] + 0.587 * data[idxR + 1] + 0.114 * data[idxR + 2];
            const lU = 0.299 * data[idxU] + 0.587 * data[idxU + 1] + 0.114 * data[idxU + 2];
            const lD = 0.299 * data[idxD] + 0.587 * data[idxD + 1] + 0.114 * data[idxD + 2];
            grad = Math.abs(lR - lL) + 0.7 * Math.abs(lD - lU);
          }

          // silhouette / subject separation from perimeter background color
          const bgDiff = Math.abs(r - meanR) + Math.abs(g - meanG) + Math.abs(b - meanB);
          const centerPrior = 1.0 - 0.14 * Math.abs(px / w - 0.5);

          // avoid misclassifying flat peach/sunset sky backdrops matching perimeter color as skin
          const isFlatBg = bgDiff < 20 && grad < 8;
          const skinScore = (isSkin && !isFlatBg) ? (yn < 0.72 ? 5.5 : 2.5) : 0.0;
          const edgeScore = grad > 22 ? Math.min(3.5, grad * 0.032) : 0.0;
          const salScore = bgDiff > 50 ? Math.min(5.0, (bgDiff - 50) * 0.04) : 0.0;

          colScores[px] += (skinScore + edgeScore + salScore) * yWeight * centerPrior;
        }
      }

      const winW = Math.max(8, Math.min(w - 1, Math.round(h * Math.max(0.4, Math.min(1.8, targetAspect)))));
      const centerSx = Math.round((w - winW) * 0.5);
      let centerSum = 0;
      for (let k = 0; k < winW; k++) centerSum += colScores[centerSx + k];

      let bestSum = centerSum;
      let bestX = centerSx;
      for (let sx = 0; sx <= w - winW; sx++) {
        let sum = 0;
        for (let k = 0; k < winW; k++) sum += colScores[sx + k];
        if (sum > bestSum) {
          bestSum = sum;
          bestX = sx;
        }
      }

      const focalX = bestSum > 60 && bestSum > centerSum * 1.12
        ? Math.max(0.18, Math.min(0.82, (bestX + winW * 0.5) / w))
        : 0.5;
      source._focalCache = { x: focalX, bucket: timeBucket, src: srcKey };
      return focalX;
    } catch {
      return 0.5;
    }
  }

  function _drawRoundedClip(ctx, x, y, w, h, radius) {
    const r = Math.min(radius, w * 0.5, h * 0.5);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.clip();
  }

  function drawMediaSmart(ctx, source, x, y, w, h, opts = {}, scratchState = null) {
    if (!ctx || !source || w <= 0 || h <= 0) return;
    const mw = source.videoWidth || source.naturalWidth || source.width || 0;
    const mh = source.videoHeight || source.naturalHeight || source.height || 0;
    if (!mw || !mh) return;

    const mAspect = mw / mh;
    const targetAspect = w / h;
    const zoom = Math.max(0.2, Number(opts.zoom) || 1.0);
    const panX = Number(opts.panX) || 0;
    const panY = Number(opts.panY) || 0;

    ctx.save();
    if (opts.opacity !== undefined) ctx.globalAlpha *= opts.opacity;
    if (opts.radius > 0 || opts.clip) {
      if (opts.radius > 0) {
        _drawRoundedClip(ctx, x, y, w, h, opts.radius);
      } else {
        ctx.beginPath();
        ctx.rect(x, y, w, h);
        ctx.clip();
      }
    }

    let dx = x;
    let dy = y;
    let dw = w;
    let dh = h;

    if (opts.fit === 'contain') {
      if (targetAspect > mAspect) {
        dw = h * mAspect;
        dx = x + (w - dw) * 0.5;
      } else {
        dh = w / mAspect;
        dy = y + (h - dh) * 0.5;
      }
      const zdw = dw * zoom;
      const zdh = dh * zoom;
      dx -= (zdw - dw) * 0.5 - panX;
      dy -= (zdh - dh) * 0.5 - panY;
      dw = zdw;
      dh = zdh;
      ctx.drawImage(source, 0, 0, mw, mh, dx, dy, dw, dh);
    } else {
      const scale = Math.max(w / mw, h / mh) * zoom;
      dw = mw * scale;
      dh = mh * scale;

      const useFocalPan = Boolean(opts.focalPan) && opts.autoFrame !== false;
      let focalX = 0.5;
      if (opts.focalX !== undefined) {
        focalX = clamp01(opts.focalX);
      } else if (useFocalPan) {
        const srcKey = source.currentSrc || source.src || '';
        if (source._curFocalSrc !== srcKey) {
          source._curFocalSrc = srcKey;
          source._curFocalX = undefined;
          source._lastFocalRenderTime = undefined;
        }
        const target = detectFocalX(source, scratchState, targetAspect);
        const hasTime = opts.time !== undefined && opts.time !== null && Number.isFinite(Number(opts.time));
        if (hasTime) {
          const t = Number(opts.time);
          if (source._lastFocalRenderTime !== undefined && Math.abs(t - source._lastFocalRenderTime) < 1e-6 && source._curFocalX !== undefined) {
            focalX = source._curFocalX;
          } else if (
            source._curFocalX === undefined
            || source._lastFocalRenderTime === undefined
            || t < source._lastFocalRenderTime
            || t - source._lastFocalRenderTime > 0.25
          ) {
            source._curFocalX = target;
            source._lastFocalRenderTime = t;
            focalX = target;
          } else {
            source._curFocalX += (target - source._curFocalX) * (opts.focalSmoothing || 0.15);
            source._lastFocalRenderTime = t;
            focalX = source._curFocalX;
          }
        } else {
          source._curFocalX = source._curFocalX === undefined
            ? target
            : source._curFocalX + (target - source._curFocalX) * (opts.focalSmoothing || 0.15);
          focalX = source._curFocalX;
        }
      } else if (source.dataset?.manualFocalX) {
        focalX = clamp01(parseFloat(source.dataset.manualFocalX));
      }

      dx = x + Math.max(w - dw, Math.min(0, w * 0.5 - focalX * dw)) + panX;
      dy = y + (h - dh) * 0.5 + panY;

      if (useFocalPan || Math.abs(zoom - 1.0) > 1e-4 || panX !== 0 || panY !== 0) {
        // clip cleanly to dest box when zoomed/panned cover overflows destination bounds
        if (!(opts.radius > 0 || opts.clip)) {
          ctx.beginPath();
          ctx.rect(x, y, w, h);
          ctx.clip();
        }
        ctx.drawImage(source, dx, dy, dw, dh);
      } else {
        // fast tight cover crop when no extra transform pan/zoom is needed
        let sx = 0, sy = 0, sw = mw, sh = mh;
        if (targetAspect > mAspect) {
          sh = mw / targetAspect;
          sy = (mh - sh) * 0.5;
        } else {
          sw = mh * targetAspect;
          sx = Math.max(0, Math.min(mw - sw, focalX * mw - sw * 0.5));
        }
        ctx.drawImage(source, sx, sy, sw, sh, x, y, w, h);
      }
    }

    if (opts.glitch > 0.005) {
      glitch(ctx, source, { x: dx, y: dy, w: dw, h: dh }, opts.glitch, opts);
    }
    ctx.restore();
  }

  // seek-safe asymmetric exponential envelope follower for smooth motion-graphic values
  function smoothSignal(store, key, target, time, opts = {}) {
    const val = Number.isFinite(Number(target)) ? Number(target) : 0;
    if (!store || typeof store.get !== 'function') return val;
    const t = Number(time) || 0;
    const attackSec = Math.max(0.005, (Number(opts.attackMs) || 75) / 1000);
    const releaseSec = Math.max(0.01, (Number(opts.releaseMs) || 280) / 1000);
    const entry = store.get(key);
    if (entry && Math.abs(t - entry.time) < 1e-6) {
      return entry.value;
    }
    if (!entry || t < entry.time || t - entry.time > 0.35) {
      store.set(key, { value: val, vel: 0, time: t });
      return val;
    }
    const dt = Math.max(0, Math.min(0.1, t - entry.time));
    const tau = val > entry.value ? attackSec : releaseSec;
    const alpha = 1 - Math.exp(-dt / tau);
    const next = entry.value + (val - entry.value) * alpha;
    entry.value = next;
    entry.time = t;
    return next;
  }

  // damped second-order spring for intentional card/scale/text follow-through
  function springSignal(store, key, target, time, opts = {}) {
    const goal = Number.isFinite(Number(target)) ? Number(target) : 0;
    if (!store || typeof store.get !== 'function') return goal;
    const t = Number(time) || 0;
    const stiffness = Math.max(10, Math.min(600, Number(opts.stiffness) || 140));
    const damping = Math.max(2, Math.min(80, Number(opts.damping) || 18));
    const entry = store.get(key);
    if (entry && Math.abs(t - entry.time) < 1e-6) {
      return entry.value;
    }
    if (!entry || t < entry.time || t - entry.time > 0.35) {
      store.set(key, { value: goal, vel: 0, time: t });
      return goal;
    }
    let dt = Math.max(0, Math.min(0.05, t - entry.time));
    // substep integration keeps spring stable even at low frame rates
    const steps = dt > 0.018 ? 2 : 1;
    const h = dt / steps;
    let x = entry.value;
    let v = entry.vel || 0;
    for (let s = 0; s < steps; s++) {
      const accel = (goal - x) * stiffness - v * damping;
      v += accel * h;
      x += v * h;
    }
    entry.value = x;
    entry.vel = v;
    entry.time = t;
    return x;
  }

  // thresholded transient/loudness gate so quiet sections stay calm and intentional
  function gateSignal(value, threshold = 0.55, softness = 0.16) {
    const v = Number(value) || 0;
    const th = Number(threshold) || 0;
    const s = Math.max(0.02, Number(softness) || 0.16);
    if (v <= th) return 0;
    const p = clamp01((v - th) / Math.max(0.05, 1 - th));
    return p <= s ? (p / s) * p : p;
  }

  const CLIP_TRANSITION_TYPES = ['none', 'glitch', 'pan', 'datamosh', 'fade', 'custom'];

  function normalizeClipTransition(params, fallback = 'glitch') {
    const raw = params && typeof params.clipTransition === 'string'
      ? params.clipTransition.trim().toLowerCase()
      : '';
    if (CLIP_TRANSITION_TYPES.includes(raw)) return raw;
    if (params && typeof params.dropGlitch === 'boolean') {
      return params.dropGlitch ? 'glitch' : 'none';
    }
    return CLIP_TRANSITION_TYPES.includes(fallback) ? fallback : 'glitch';
  }

  function normalizeClipTransitionDuration(params, fallback = 0.35) {
    const raw = Number(params?.clipTransitionDuration);
    const base = Number.isFinite(raw) ? raw : Number(fallback) || 0.35;
    return Math.max(0.05, Math.min(1.5, base));
  }

  function resolveClipTransitionInfo(time, project, opts = {}) {
    const t = Number(time) || 0;
    const dur = Math.max(0.5, Number(project?.duration) || 30.0);
    const rawDuration = normalizeClipTransitionDuration(opts, 0.35);
    if (opts.customTransition === true) {
      return {
        type: 'custom',
        duration: 0,
        rawDuration,
        active: false,
        progress: 1,
        cutIndex: 0,
        cutStart: 0,
        cutEnd: dur,
        isDropIn: false
      };
    }

    const type = normalizeClipTransition(opts, 'glitch');
    const startAtDrop = opts.startAtDrop !== false;
    const cutMode = opts.cutMode || 'chord';
    const dropTime = Number.isFinite(opts.dropTime) ? opts.dropTime : resolveDropTime(project);

    const interval = _resolveCutInterval(t, project, cutMode, startAtDrop);
    const span = Math.max(0.1, interval.end - interval.start);

    if (type === 'pan') {
      const preDur = Math.min(rawDuration * 0.35, Math.max(0.04, span * 0.32));
      const postDur = Math.min(rawDuration * 0.65, Math.max(0.06, span * 0.52));
      if (startAtDrop && t < dropTime) {
        const dropPreDur = Math.min(rawDuration * 0.35, Math.max(0.04, dropTime * 0.35));
        if (dropTime >= dropPreDur + 0.08 && t >= dropTime - dropPreDur) {
          return {
            type,
            phase: 'out',
            duration: dropPreDur,
            rawDuration,
            active: true,
            progress: clamp01((t - (dropTime - dropPreDur)) / dropPreDur),
            cutIndex: 0,
            cutStart: dropTime,
            cutEnd: dur,
            isDropIn: true
          };
        }
        return {
          type,
          phase: 'cruise',
          duration: rawDuration,
          rawDuration,
          active: false,
          progress: 0,
          cutIndex: 0,
          cutStart: dropTime,
          cutEnd: dur,
          isDropIn: true
        };
      }

      const cutAge = Math.max(0, t - interval.start);
      if (cutAge < postDur) {
        return {
          type,
          phase: 'in',
          duration: postDur,
          rawDuration,
          active: true,
          progress: clamp01(cutAge / postDur),
          cutIndex: interval.index || 0,
          cutStart: interval.start,
          cutEnd: interval.end,
          isDropIn: startAtDrop && (interval.index || 0) === 0
        };
      }

      const timeToEnd = Math.max(0, interval.end - t);
      if (interval.end < dur - 0.02 && timeToEnd <= preDur) {
        return {
          type,
          phase: 'out',
          duration: preDur,
          rawDuration,
          active: true,
          progress: clamp01((preDur - timeToEnd) / preDur),
          cutIndex: (interval.index || 0) + 1,
          cutStart: interval.start,
          cutEnd: interval.end,
          isDropIn: false
        };
      }

      return {
        type,
        phase: 'cruise',
        duration: postDur,
        rawDuration,
        active: false,
        progress: 1,
        cutIndex: interval.index || 0,
        cutStart: interval.start,
        cutEnd: interval.end,
        isDropIn: startAtDrop && (interval.index || 0) === 0
      };
    }

    if (startAtDrop && t < dropTime) {
      return {
        type,
        phase: 'cruise',
        duration: rawDuration,
        rawDuration,
        active: false,
        progress: 0,
        cutIndex: 0,
        cutStart: dropTime,
        cutEnd: dur,
        isDropIn: true
      };
    }

    const effDur = Math.min(rawDuration, Math.max(0.08, span * 0.78));
    const cutAge = Math.max(0, t - interval.start);
    const active = type !== 'none' && type !== 'custom' && cutAge >= 0 && cutAge < effDur;

    return {
      type,
      phase: active ? 'in' : 'cruise',
      duration: effDur,
      rawDuration,
      active,
      progress: active ? clamp01(cutAge / effDur) : 1,
      cutIndex: interval.index || 0,
      cutStart: interval.start,
      cutEnd: interval.end,
      isDropIn: startAtDrop && (interval.index || 0) === 0
    };
  }

  function createClipTransitionState() {
    return {
      prevCanvas: null,
      prevCtx: null,
      currCanvas: null,
      currCtx: null,
      outCanvas: null,
      outCtx: null,
      moshCanvas: null,
      moshCtx: null,
      moshData: null,
      moshPrevData: null,
      targetCanvas: null,
      targetCtx: null,
      targetData: null,
      targetLuma: null,
      prevLuma: null,
      flowCanvas: null,
      flowCtx: null,
      holdVx: null,
      holdVy: null,
      holdErr: null,
      holdCols: 0,
      holdRows: 0,
      panBlurCanvasA: null,
      panBlurCtxA: null,
      panBlurCanvasB: null,
      panBlurCtxB: null,
      prevCutIndex: -1,
      prevTime: -1,
      lastMoshCutIndex: -1,
      lastMoshProgress: -1,
      moshW: 0,
      moshH: 0,
      flowW: 0,
      flowH: 0
    };
  }

  function disposeClipTransitionState(ts) {
    if (!ts) return;
    ts.prevCtx = null;
    ts.prevCanvas = null;
    ts.currCtx = null;
    ts.currCanvas = null;
    ts.outCtx = null;
    ts.outCanvas = null;
    ts.moshCtx = null;
    ts.moshCanvas = null;
    ts.moshData = null;
    ts.moshPrevData = null;
    ts.targetCtx = null;
    ts.targetCanvas = null;
    ts.targetData = null;
    ts.targetLuma = null;
    ts.prevLuma = null;
    ts.flowCtx = null;
    ts.flowCanvas = null;
    ts.holdVx = null;
    ts.holdVy = null;
    ts.holdErr = null;
    ts.holdCols = 0;
    ts.holdRows = 0;
    ts.panBlurCtxA = null;
    ts.panBlurCanvasA = null;
    ts.panBlurCtxB = null;
    ts.panBlurCanvasB = null;
    ts.prevCutIndex = -1;
    ts.lastMoshCutIndex = -1;
  }

  function _ensureBufferCanvas(ts, canvasKey, ctxKey, w, h, readFreq = false) {
    if (typeof document === 'undefined') return null;
    let c = ts[canvasKey];
    let cctx = ts[ctxKey];
    if (!c) {
      c = document.createElement('canvas');
      ts[canvasKey] = c;
      cctx = null;
    }
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
      cctx = null;
    }
    if (!cctx) {
      cctx = c.getContext('2d', readFreq ? { willReadFrequently: true } : undefined);
      ts[ctxKey] = cctx;
    }
    return cctx;
  }

  function _ensureTransitionMoshBuffers(ts, mw, mh, fw, fh) {
    const mctx = _ensureBufferCanvas(ts, 'moshCanvas', 'moshCtx', mw, mh, true);
    const tctx = _ensureBufferCanvas(ts, 'targetCanvas', 'targetCtx', mw, mh, true);
    const fctx = _ensureBufferCanvas(ts, 'flowCanvas', 'flowCtx', fw, fh, true);
    if (!mctx || !tctx || !fctx) return false;
    if (ts.moshW !== mw || ts.moshH !== mh || !ts.moshData) {
      ts.moshData = mctx.createImageData(mw, mh);
      ts.moshPrevData = new Uint8ClampedArray(ts.moshData.data.length);
      ts.targetData = null;
      ts.moshW = mw;
      ts.moshH = mh;
    }
    if (ts.flowW !== fw || ts.flowH !== fh) {
      ts.prevLuma = null;
      ts.targetLuma = null;
      ts.flowW = fw;
      ts.flowH = fh;
    }
    return true;
  }

  function _measureLumaDelta(a, b) {
    if (!a || !b || a.length !== b.length || a.length === 0) return 999;
    let sum = 0;
    const step = 4;
    let count = 0;
    for (let i = 0; i < a.length; i += step) {
      const d = a[i] - b[i];
      sum += d < 0 ? -d : d;
      count++;
    }
    return count > 0 ? sum / count : 0;
  }

  function _renderDatamoshTransition(destCtx, ts, prevCanvas, currCanvas, x, y, w, h, info) {
    const p = info.progress;
    if (p >= 0.96) {
      destCtx.drawImage(currCanvas, x, y, w, h);
      ts.lastMoshCutIndex = info.cutIndex;
      ts.lastMoshProgress = p;
      return;
    }

    const lu = typeof window !== 'undefined' ? window.loopUtils : null;
    const hasCodec = Boolean(lu?.estimateCodecMotion && lu?.advectCodecDatamosh);
    if (!lu?.extractLuma || (!hasCodec && (!lu?.estimateBlockMotion || !lu?.advectDatamoshPixels))) {
      destCtx.drawImage(prevCanvas, x, y, w, h);
      destCtx.save();
      destCtx.globalAlpha *= ease(p, 'smoother');
      destCtx.drawImage(currCanvas, x, y, w, h);
      destCtx.restore();
      return;
    }

    const scale = Math.min(0.55, 320 / Math.max(1, Math.min(w, h)));
    const mw = Math.max(96, Math.round(w * scale));
    const mh = Math.max(96, Math.round(h * scale));
    const cellSize = hasCodec ? 5 : 4;
    const cols = 32;
    const fw = cols * cellSize;
    const fh = Math.max(cellSize * 10, Math.round(fw * (h / Math.max(1, w)) / cellSize) * cellSize);
    const rows = Math.floor(fh / cellSize);

    if (!_ensureTransitionMoshBuffers(ts, mw, mh, fw, fh)) {
      destCtx.drawImage(currCanvas, x, y, w, h);
      return;
    }

    if (ts.holdCols !== cols || ts.holdRows !== rows || !ts.holdVx) {
      ts.holdVx = new Float32Array(cols * rows);
      ts.holdVy = new Float32Array(cols * rows);
      ts.holdErr = new Float32Array(cols * rows);
      ts.holdCols = cols;
      ts.holdRows = rows;
    }

    const isFresh = ts.lastMoshCutIndex !== info.cutIndex || p < ts.lastMoshProgress - 0.04 || p < 0.05;
    if (isFresh) {
      ts.moshCtx.drawImage(prevCanvas, 0, 0, mw, mh);
      const initPixels = ts.moshCtx.getImageData(0, 0, mw, mh).data;
      ts.moshData.data.set(initPixels);
      ts.prevLuma = lu.extractLuma(ts.flowCtx, prevCanvas, fw, fh);
      ts.holdVx.fill(0);
      ts.holdVy.fill(0);
      ts.holdErr.fill(0);
    }

    // sample live incoming clip every frame so macroblock refreshes track real playing video
    ts.targetCtx.drawImage(currCanvas, 0, 0, mw, mh);
    ts.targetData = ts.targetCtx.getImageData(0, 0, mw, mh).data;
    const currLuma = lu.extractLuma(ts.flowCtx, currCanvas, fw, fh);
    ts.targetLuma = currLuma;

    const vx = new Float32Array(cols * rows);
    const vy = new Float32Array(cols * rows);
    const blockErr = new Float32Array(cols * rows);

    if (hasCodec) {
      const refLuma = ts.prevLuma || currLuma;
      const frameDelta = isFresh ? 999 : _measureLumaDelta(currLuma, refLuma);
      if (frameDelta > 2.2) {
        const activeCount = lu.estimateCodecMotion(currLuma, refLuma, fw, fh, cellSize, cols, rows, vx, vy, blockErr);
        if (activeCount > 0 || isFresh) {
          ts.holdVx.set(vx);
          ts.holdVy.set(vy);
          ts.holdErr.set(blockErr);
        }
        ts.prevLuma = currLuma;
      } else {
        // sustain macroblock momentum cleanly across held 12fps/8fps anime cels
        for (let i = 0; i < ts.holdVx.length; i++) {
          ts.holdVx[i] *= 0.92;
          ts.holdVy[i] *= 0.92;
          vx[i] = ts.holdVx[i];
          vy[i] = ts.holdVy[i];
          blockErr[i] = ts.holdErr[i];
        }
      }
      if (frameDelta > 2.2) {
        vx.set(ts.holdVx);
        vy.set(ts.holdVy);
        blockErr.set(ts.holdErr);
      }
    } else {
      lu.estimateBlockMotion(currLuma, ts.prevLuma || ts.targetLuma, fw, fh, cellSize, cols, rows, vx, vy);
      ts.prevLuma = currLuma;
    }

    // on a cold seek mid-transition, run brief warmup advection steps so paused scrubs stay moshed
    const steps = isFresh && p > 0.08 ? [p * 0.25, p * 0.6, p] : [p];
    const moshPixels = ts.moshData.data;
    for (let s = 0; s < steps.length; s++) {
      ts.moshPrevData.set(moshPixels);
      if (hasCodec) {
        lu.advectCodecDatamosh(moshPixels, ts.moshPrevData, ts.targetData, vx, vy, blockErr, mw, mh, fw, fh, cols, rows, steps[s], info.cutIndex);
      } else {
        lu.advectDatamoshPixels(moshPixels, ts.moshPrevData, ts.targetData, vx, vy, mw, mh, fw, fh, cols, rows, steps[s]);
      }
    }
    ts.moshCtx.putImageData(ts.moshData, 0, 0);

    const prevSmooth = destCtx.imageSmoothingEnabled;
    destCtx.imageSmoothingEnabled = !hasCodec || p > 0.88;
    destCtx.drawImage(ts.moshCanvas, x, y, w, h);
    destCtx.imageSmoothingEnabled = prevSmooth;
    if (p > 0.84) {
      const settle = (p - 0.84) / 0.12;
      destCtx.save();
      destCtx.globalAlpha *= Math.min(1, settle * settle * (3 - 2 * settle));
      destCtx.drawImage(currCanvas, x, y, w, h);
      destCtx.restore();
    }

    ts.lastMoshCutIndex = info.cutIndex;
    ts.lastMoshProgress = p;
  }

  function _panSmoothWindow(u) {
    if (u <= 0 || u >= 1) return 0;
    const x = u * (1 - u);
    return 64 * x * x * x;
  }

  function _panSmoothWindowDeriv(u) {
    if (u <= 0 || u >= 1) return 0;
    const x = u * (1 - u);
    return 192 * x * x * (1 - 2 * u);
  }

  // c1-continuous straddled whip-pan curve: pre-cut anticipation coil & launch -> peak velocity at cut -> silky asymptotic settle
  function _evalWhipPanCurve(p, hasOutgoing, phase = 'in') {
    const t = clamp01(p);
    if (phase === 'out') {
      const coilSpan = 0.58;
      const coil = -0.028 * _panSmoothWindow(t / coilSpan);
      const dCoil = (-0.028 / coilSpan) * _panSmoothWindowDeriv(t / coilSpan);
      const launch = 0.22 * (0.28 * Math.pow(t, 3) + 0.72 * Math.pow(t, 6));
      const dLaunch = 0.22 * (0.84 * Math.pow(t, 2) + 4.32 * Math.pow(t, 5));
      return {
        s: coil + launch,
        vel: (dCoil + dLaunch) / 0.35
      };
    }

    const k = 2.68;
    const rem = Math.pow(1 - t, k);
    const dRem = k * Math.pow(1 - t, k - 1);
    if (!hasOutgoing) {
      return {
        s: 0.45 + 0.55 * (1 - rem),
        vel: (0.55 * dRem) / 0.65
      };
    }
    return {
      s: 0.22 + 0.78 * (1 - rem),
      vel: (0.78 * dRem) / 0.65
    };
  }

  // deterministic non-repeating 360-deg pan angle per cut (turns >= 81 deg between consecutive cuts)
  function _resolvePanAngle(cutIndex, seed = 0) {
    const idx = Math.max(0, Math.floor(cutIndex) || 0);
    let angle = hash(17.3 + seed * 3.7) * Math.PI * 2;
    for (let i = 1; i <= idx; i++) {
      angle += Math.PI * (0.45 + hash(i * 31.7 + 9.2 + seed * 5.3) * 1.10);
    }
    return angle;
  }

  function _drawMirroredFrame(ctx, src, originX, originY, tileW, tileH, clipW, clipH) {
    const minIx = Math.floor(-originX / tileW);
    const maxIx = Math.floor((clipW - 1 - originX) / tileW);
    const minIy = Math.floor(-originY / tileH);
    const maxIy = Math.floor((clipH - 1 - originY) / tileH);
    for (let ix = minIx; ix <= maxIx; ix++) {
      const flipX = (Math.abs(ix) % 2) === 1;
      const rx = originX + ix * tileW;
      for (let iy = minIy; iy <= maxIy; iy++) {
        const flipY = (Math.abs(iy) % 2) === 1;
        const ry = originY + iy * tileH;
        ctx.save();
        ctx.translate(rx + (flipX ? tileW : 0), ry + (flipY ? tileH : 0));
        if (flipX || flipY) ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1);
        ctx.drawImage(src, 0, 0, tileW, tileH);
        ctx.restore();
      }
    }
  }

  // 5-6 pass iterative shift-average gives continuous 32-64 tap directional blur along (ux, uy)
  function _applyDirectionalBlur(ts, mw, mh, pad, ux, uy, blurPx) {
    const bufW = mw + pad * 2;
    const bufH = mh + pad * 2;
    const ctxB = _ensureBufferCanvas(ts, 'panBlurCanvasB', 'panBlurCtxB', bufW, bufH, false);
    const ctxA = ts.panBlurCtxA;
    if (!ctxA || !ctxB) return ts.panBlurCanvasA;

    const maxSafeBlur = Math.max(0, pad * 2 - 4);
    const clampedBlur = Math.min(maxSafeBlur, Math.max(0, blurPx));
    if (clampedBlur < 1.5) return ts.panBlurCanvasA;

    const passes = clampedBlur > 48 ? 6 : 5;
    const taps = (1 << passes) - 1;
    const step = clampedBlur / taps;
    let srcCanvas = ts.panBlurCanvasA;
    let dstCanvas = ts.panBlurCanvasB;
    let dstCtx = ctxB;

    for (let pass = 0; pass < passes; pass++) {
      const shift = (1 << pass) * 0.5 * step;
      const sx = ux * shift;
      const sy = uy * shift;
      dstCtx.save();
      dstCtx.clearRect(0, 0, bufW, bufH);
      dstCtx.globalAlpha = 1;
      dstCtx.drawImage(srcCanvas, -sx, -sy, bufW, bufH);
      dstCtx.globalAlpha = 0.5;
      dstCtx.drawImage(srcCanvas, sx, sy, bufW, bufH);
      dstCtx.restore();

      const tmpC = srcCanvas;
      srcCanvas = dstCanvas;
      dstCanvas = tmpC;
      dstCtx = srcCanvas === ts.panBlurCanvasA ? ctxB : ctxA;
    }
    return srcCanvas;
  }

  function _renderPanTransition(destCtx, ts, prevCanvas, currCanvas, hasOutgoing, x, y, w, h, info, opts) {
    const p = info.progress;
    const phase = info.phase || 'in';
    const baseAlpha = destCtx.globalAlpha;
    if (phase === 'in' && p >= 0.992) {
      destCtx.drawImage(currCanvas, x, y, w, h);
      return;
    }

    const seed = Number(opts.project?.dropTime) || 0;
    const theta = _resolvePanAngle(info.cutIndex, seed);
    const ux = Math.cos(theta);
    const uy = Math.sin(theta);

    const { s, vel } = _evalWhipPanCurve(p, hasOutgoing, phase);
    const whipEnv = clamp01(Math.abs(vel) / 3.24);
    const coilZoom = phase === 'out' && s < 0 ? Math.max(-0.025, s * 0.65) : 0;
    const zoomScale = 1 + coilZoom + whipEnv * 0.026;

    const mw = currCanvas.width || Math.max(64, Math.round(w));
    const mh = currCanvas.height || Math.max(64, Math.round(h));
    const spanBuf = Math.abs(ux) * mw + Math.abs(uy) * mh;
    const pad = Math.min(180, Math.max(24, Math.round(Math.max(mw, mh) * 0.28)));
    const bufW = mw + pad * 2;
    const bufH = mh + pad * 2;
    const ctxA = _ensureBufferCanvas(ts, 'panBlurCanvasA', 'panBlurCtxA', bufW, bufH, false);

    if (!ctxA) {
      destCtx.drawImage(currCanvas, x, y, w, h);
      return;
    }

    ctxA.save();
    ctxA.clearRect(0, 0, bufW, bufH);
    const cx = pad + mw * 0.5;
    const cy = pad + mh * 0.5;
    ctxA.translate(cx, cy);
    ctxA.scale(zoomScale, zoomScale);
    ctxA.translate(-cx, -cy);

    if (phase === 'out') {
      const outOffX = pad - s * spanBuf * ux;
      const outOffY = pad - s * spanBuf * uy;
      _drawMirroredFrame(ctxA, currCanvas, outOffX, outOffY, mw, mh, bufW, bufH);
    } else if (hasOutgoing) {
      const prevOffX = pad - s * spanBuf * ux;
      const prevOffY = pad - s * spanBuf * uy;
      const currOffX = pad + (1 - s) * spanBuf * ux;
      const currOffY = pad + (1 - s) * spanBuf * uy;
      const cutProj = (0.5 - s) * spanBuf;
      const big = bufW + bufH;

      ctxA.save();
      ctxA.translate(cx, cy);
      ctxA.rotate(theta);
      ctxA.beginPath();
      ctxA.rect(-big, -big, big + cutProj, big * 2);
      ctxA.clip();
      ctxA.rotate(-theta);
      ctxA.translate(-cx, -cy);
      _drawMirroredFrame(ctxA, prevCanvas, prevOffX, prevOffY, mw, mh, bufW, bufH);
      ctxA.restore();

      ctxA.save();
      ctxA.translate(cx, cy);
      ctxA.rotate(theta);
      ctxA.beginPath();
      ctxA.rect(cutProj, -big, big - cutProj, big * 2);
      ctxA.clip();
      ctxA.rotate(-theta);
      ctxA.translate(-cx, -cy);
      _drawMirroredFrame(ctxA, currCanvas, currOffX, currOffY, mw, mh, bufW, bufH);
      ctxA.restore();
    } else {
      const currOffX = pad + (1 - s) * 0.75 * spanBuf * ux;
      const currOffY = pad + (1 - s) * 0.75 * spanBuf * uy;
      _drawMirroredFrame(ctxA, currCanvas, currOffX, currOffY, mw, mh, bufW, bufH);
    }
    ctxA.restore();

    const blurPx = whipEnv * Math.min(220, spanBuf * 0.26);
    const finalBuf = _applyDirectionalBlur(ts, mw, mh, pad, ux, uy, blurPx);

    if (phase === 'in' && !hasOutgoing) {
      destCtx.globalAlpha = baseAlpha * ease(clamp01(p / 0.22), 'quadOut');
    }
    destCtx.drawImage(finalBuf, pad, pad, mw, mh, x, y, w, h);

    if (whipEnv > 0.10) {
      destCtx.save();
      destCtx.translate(x, y);
      destCtx.globalAlpha = baseAlpha;
      whipLines(destCtx, w, h, whipEnv * 0.95, {
        time: opts.time,
        angle: theta,
        alpha: 0.30,
        count: 16,
        length: Math.min(w, h) * (0.42 + 0.52 * whipEnv),
        seed: info.cutIndex * 13.7
      });
      destCtx.restore();
    }
  }

  function _drawTransitionComposite(destCtx, ts, prevCanvas, currCanvas, hasOutgoing, x, y, w, h, info, opts) {
    const p = info.progress;
    const baseAlpha = destCtx.globalAlpha;

    if (info.type === 'fade') {
      const pEase = ease(p, 'smoother');
      if (hasOutgoing) {
        destCtx.drawImage(prevCanvas, x, y, w, h);
        destCtx.globalAlpha = baseAlpha * pEase;
        destCtx.drawImage(currCanvas, x, y, w, h);
      } else {
        destCtx.globalAlpha = baseAlpha * pEase;
        destCtx.drawImage(currCanvas, x, y, w, h);
      }
      return;
    }

    if (info.type === 'pan') {
      _renderPanTransition(destCtx, ts, prevCanvas, currCanvas, hasOutgoing, x, y, w, h, info, opts);
      return;
    }

    if (info.type === 'datamosh') {
      if (hasOutgoing) {
        _renderDatamoshTransition(destCtx, ts, prevCanvas, currCanvas, x, y, w, h, info);
      } else {
        const env = Math.pow(1 - p, 1.5);
        destCtx.globalAlpha = baseAlpha * ease(p, 'cubicOut');
        destCtx.drawImage(currCanvas, x, y, w, h);
        if (env > 0.02) {
          glitch(destCtx, currCanvas, { x, y, w, h }, env * 0.75, {
            time: opts.time,
            rgbShift: 2.0,
            slices: 6,
            scanlines: false
          });
        }
      }
      return;
    }

    // glitch transition
    const env = Math.pow(1 - p, 1.8);
    if (hasOutgoing && p < 0.30) {
      destCtx.drawImage(prevCanvas, x, y, w, h);
      const swapSlices = 4;
      const step = Math.floor((Number(opts.time) || 0) * 45 + p * 12);
      for (let i = 0; i < swapSlices; i++) {
        const seed = step * 19.7 + i * 11.3;
        const ny = (hash(seed) * 0.75 + i * 0.2) % 0.86;
        const nh = 0.04 + hash(seed + 2.1) * 0.10;
        const sy = Math.floor(ny * currCanvas.height);
        const sh = Math.max(1, Math.min(Math.floor(nh * currCanvas.height), currCanvas.height - sy));
        destCtx.drawImage(currCanvas, 0, sy, currCanvas.width, sh, x, y + ny * h, w, nh * h);
      }
      glitch(destCtx, currCanvas, { x, y, w, h }, env, { time: opts.time, rgbShift: 8, slices: 5 });
    } else {
      destCtx.drawImage(currCanvas, x, y, w, h);
      glitch(destCtx, currCanvas, { x, y, w, h }, env, { time: opts.time, rgbShift: 7.5, slices: 5 });
    }
  }

  function _resolveBufferDims(w, h, maxSide = 640) {
    const scale = Math.min(1, maxSide / Math.max(1, w, h));
    return {
      bw: Math.max(64, Math.round(w * scale)),
      bh: Math.max(64, Math.round(h * scale))
    };
  }

  function drawMediaWithTransition(destCtx, source, x, y, w, h, opts = {}, scratchState = null, transState = null) {
    if (!destCtx || !source || w <= 0 || h <= 0) return;
    const info = resolveClipTransitionInfo(opts.time, opts.project, opts);
    if (opts.transition === false || opts.customTransition === true || info.type === 'none' || info.type === 'custom' || !transState) {
      drawMediaSmart(destCtx, source, x, y, w, h, opts, scratchState);
      return;
    }

    const { bw, bh } = _resolveBufferDims(w, h, 640);
    const frameOpts = { ...opts, opacity: 1, radius: 0, clip: false, glitch: 0 };
    const t = Number(opts.time) || 0;

    if (!info.active) {
      drawMediaSmart(destCtx, source, x, y, w, h, opts, scratchState);
      // keep outgoing snapshot updated for the next cut boundary
      if (transState.prevCutIndex !== info.cutIndex || Math.abs(t - transState.prevTime) > 0.03) {
        const pctx = _ensureBufferCanvas(transState, 'prevCanvas', 'prevCtx', bw, bh, false);
        if (pctx) {
          pctx.clearRect(0, 0, bw, bh);
          drawMediaSmart(pctx, source, 0, 0, bw, bh, frameOpts, scratchState);
          transState.prevCutIndex = info.cutIndex;
          transState.prevTime = t;
        }
      }
      return;
    }

    let hasOutgoing = info.cutIndex > 0 && transState.prevCutIndex === info.cutIndex - 1 && Boolean(transState.prevCanvas);
    if (!hasOutgoing && info.cutIndex > 0 && opts.prevSource) {
      const pmw = opts.prevSource.videoWidth || opts.prevSource.naturalWidth || opts.prevSource.width || 0;
      const pmh = opts.prevSource.videoHeight || opts.prevSource.naturalHeight || opts.prevSource.height || 0;
      if (pmw > 0 && pmh > 0) {
        const pctx = _ensureBufferCanvas(transState, 'prevCanvas', 'prevCtx', bw, bh, false);
        if (pctx) {
          pctx.clearRect(0, 0, bw, bh);
          drawMediaSmart(pctx, opts.prevSource, 0, 0, bw, bh, frameOpts, scratchState);
          transState.prevCutIndex = info.cutIndex - 1;
          hasOutgoing = true;
        }
      }
    }

    const cctx = _ensureBufferCanvas(transState, 'currCanvas', 'currCtx', bw, bh, false);
    if (!cctx) {
      drawMediaSmart(destCtx, source, x, y, w, h, opts, scratchState);
      return;
    }
    cctx.clearRect(0, 0, bw, bh);
    drawMediaSmart(cctx, source, 0, 0, bw, bh, frameOpts, scratchState);

    if (info.phase === 'out' && info.cutIndex > 0) {
      const pctx = _ensureBufferCanvas(transState, 'prevCanvas', 'prevCtx', bw, bh, false);
      if (pctx) {
        pctx.clearRect(0, 0, bw, bh);
        pctx.drawImage(transState.currCanvas, 0, 0, bw, bh);
        transState.prevCutIndex = info.cutIndex - 1;
        transState.prevTime = t;
      }
    }

    destCtx.save();
    if (opts.opacity !== undefined) destCtx.globalAlpha *= clamp01(opts.opacity);
    if (opts.radius > 0) {
      _drawRoundedClip(destCtx, x, y, w, h, opts.radius);
    } else {
      destCtx.beginPath();
      destCtx.rect(x, y, w, h);
      destCtx.clip();
    }
    _drawTransitionComposite(destCtx, transState, transState.prevCanvas, transState.currCanvas, hasOutgoing, x, y, w, h, info, opts);
    destCtx.restore();
  }

  function prepareTransitionSource(source, pw, ph, opts = {}, scratchState = null, transState = null) {
    if (!source || !transState) return source;
    const info = resolveClipTransitionInfo(opts.time, opts.project, opts);
    if (opts.customTransition === true || info.type === 'none' || info.type === 'custom') {
      return source;
    }
    const { bw, bh } = _resolveBufferDims(pw, ph, 720);
    const frameOpts = { ...opts, fit: opts.fit || 'cover', opacity: 1, radius: 0, clip: false, glitch: 0 };
    const t = Number(opts.time) || 0;

    if (!info.active) {
      if (transState.prevCutIndex !== info.cutIndex || Math.abs(t - transState.prevTime) > 0.03) {
        const pctx = _ensureBufferCanvas(transState, 'prevCanvas', 'prevCtx', bw, bh, false);
        if (pctx) {
          pctx.clearRect(0, 0, bw, bh);
          drawMediaSmart(pctx, source, 0, 0, bw, bh, frameOpts, scratchState);
          transState.prevCutIndex = info.cutIndex;
          transState.prevTime = t;
        }
      }
      return source;
    }

    const octx = _ensureBufferCanvas(transState, 'outCanvas', 'outCtx', bw, bh, false);
    if (!octx) return source;
    octx.clearRect(0, 0, bw, bh);
    drawMediaWithTransition(octx, source, 0, 0, bw, bh, frameOpts, scratchState, transState);
    return transState.outCanvas || source;
  }

  function createScratchState() {
    return { canvas: null, ctx: null };
  }

  function disposeScratchState(scratchState) {
    if (!scratchState) return;
    scratchState.ctx = null;
    scratchState.canvas = null;
  }

  window.motionKit = {
    clamp01,
    lerp,
    hash,
    ease,
    impulse,
    transition,
    preDrop,
    camera,
    resolveCustomCutTimes,
    resolveCutInterval: _resolveCutInterval,
    getSpeedRampInfo,
    shutterBlur,
    streak,
    whipLines,
    glitch,
    detectFocalX,
    drawMediaSmart,
    normalizeClipTransition,
    normalizeClipTransitionDuration,
    resolveClipTransitionInfo,
    createClipTransitionState,
    disposeClipTransitionState,
    drawMediaWithTransition,
    prepareTransitionSource,
    smoothSignal,
    springSignal,
    gateSignal,
    createScratchState,
    disposeScratchState
  };
})();
