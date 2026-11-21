// regression: a repeated recognizer word must not merge across a long gap into one anchor,
// which used to pin the opening lyric to 0:00 and stretch it across the whole intro
global.window = {};
require('../public/js/services/lyricsService.js');
const lyricsService = global.window.lyricsService;

let failures = 0;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures += 1;
  console.log(`${pass ? 'pass' : 'FAIL'}  ${label.padEnd(52)} got=${JSON.stringify(actual)} want=${JSON.stringify(expected)}`);
}

const hopSec = 0.02;
const duration = 20;
const frameCount = Math.round(duration / hopSec);
const env = new Float32Array(frameCount);
for (let f = 0; f < frameCount; f++) {
  env[f] = f * hopSec < 9 ? 0.02 : 0.5;
}
const onsets = [];
for (let t = 9.2; t < 18; t += 0.32) onsets.push(Number(t.toFixed(2)));

const envelope = {
  onsets,
  firstActive: 0.15,
  lastActive: 18.2,
  env,
  hopSec,
  maxEnv: 0.5,
  activeThresh: 0.18,
  duration
};

// the opening "you" at 0.42 is a recognizer hallucination over the intro; the real line starts 9.24
const sttWords = [
  { text: 'you', start: 0.42, end: 0.62 },
  { text: 'you', start: 9.24, end: 9.5 },
  { text: 'thought', start: 9.5, end: 9.8 },
  { text: 'you', start: 9.8, end: 10.05 },
  { text: 'were', start: 10.05, end: 10.3 },
  { text: 'someone', start: 10.3, end: 10.7 },
  { text: 'you', start: 11.0, end: 11.2 },
  { text: 'thought', start: 11.2, end: 11.5 },
  { text: 'you', start: 11.5, end: 11.7 },
  { text: 'had', start: 11.7, end: 11.9 },
  { text: 'a', start: 11.9, end: 12.0 },
  { text: 'life', start: 12.0, end: 12.4 }
];

const lyrics = [
  'You thought you were someone',
  'You thought you had a life',
  'You thought you had a woman',
  'But then that moment passed'
].join('\n');

const result = lyricsService.alignPastedLyricsToAudio(lyrics, sttWords, null, duration, envelope, { granularity: 'sentences' });
const firstLine = result.lines[0];
const openingNearVocal = firstLine.start >= 8.6 && firstLine.start <= 9.9;
const longestLine = result.lines.reduce((max, line) => Math.max(max, line.end - line.start), 0);

check('opening line starts at the vocal, not the intro', openingNearVocal, true);
check('no line is stretched across the intro', longestLine < 3.5, true);
check('alignment reports matched words', result.matchedWords > 0, true);
check('alignment is not flagged as estimated', result.estimated, false);
check('lines stay ordered', result.lines.every((line, i) => i === 0 || line.start >= result.lines[i - 1].start), true);
check('lines never overlap', result.lines.every((line, i) => i === 0 || line.start >= result.lines[i - 1].end - 0.001), true);

// hallucinations usually arrive as a short cluster, not a single word: both "you" and "thought"
// sit inside the intro and must not pin the opening line there
const clusteredStt = [
  { text: 'you', start: 0.42, end: 0.62 },
  { text: 'thought', start: 0.62, end: 0.9 },
  { text: 'you', start: 9.24, end: 9.5 },
  { text: 'thought', start: 9.5, end: 9.8 },
  { text: 'you', start: 9.8, end: 10.05 },
  { text: 'were', start: 10.05, end: 10.3 },
  { text: 'someone', start: 10.3, end: 10.7 }
];
const clustered = lyricsService.alignPastedLyricsToAudio(lyrics, clusteredStt, null, duration, envelope, { granularity: 'sentences' });
// with no recognizer evidence for the dropped words we cannot know exactly where they were sung,
// so the requirement is that the opening line reaches the vocal instead of being pinned to 0:00
// or crushed into the moments before it
check('cluster hallucination does not pin the opening', clustered.lines[0].start > 1.5 && clustered.lines[0].end >= 8.8, true);
check('cluster hallucination does not crush the opening', clustered.lines[0].end - clustered.lines[0].start > 1.0, true);

// a phrase opening is never pulled earlier than the attack, even when the recognizer was
// confident about an earlier start: that was showing the first word before the sentence began
const sparseEnvelope = {
  onsets: [9.2, 9.5, 10.0, 10.3],
  firstActive: 0.15,
  lastActive: 12,
  env,
  hopSec,
  maxEnv: 0.5,
  activeThresh: 0.18,
  duration
};
const earlyLineStt = [
  { text: 'alpha', start: 9.2, end: 9.45 },
  { text: 'bravo', start: 9.5, end: 9.7 },
  { text: 'charlie', start: 9.8, end: 10.2 },
  { text: 'delta', start: 10.3, end: 10.6 }
];
const earlyLine = lyricsService.alignPastedLyricsToAudio('alpha bravo\ncharlie delta', earlyLineStt, null, duration, sparseEnvelope, { granularity: 'words' });
const charlie = earlyLine.lines.find((line) => line.text === 'charlie');
// 10.0 attack minus the 50ms readability lead = 9.95; unsnapped would be 9.8 - 0.05 = 9.75
check('line opening snaps forward to its attack', Boolean(charlie) && charlie.start >= 9.9, true);

// when only a late phrase is recognized, the prefix must not be crushed into the moments just
// before it — that put an entire verse immediately after the drop marker
const lateLyrics = [
  'That was the night we met',
  'We were young and free',
  'You said you would never go',
  "It's so evident"
].join('\n');
const lateStt = [
  { text: "it's", start: 30.0, end: 30.2 },
  { text: 'so', start: 30.2, end: 30.4 },
  { text: 'evident', start: 30.4, end: 30.9 }
];
const lateEnvelope = {
  onsets: [30.0, 30.25, 30.5],
  firstActive: 0.2,
  lastActive: 34,
  env: (() => {
    const frames = new Float32Array(Math.round(36 / hopSec));
    for (let i = 0; i < frames.length; i++) frames[i] = i * hopSec < 29.4 ? 0.45 : 0.02;
    return frames;
  })(),
  hopSec,
  maxEnv: 0.45,
  activeThresh: 0.18,
  duration: 36
};
const late = lyricsService.alignPastedLyricsToAudio(lateLyrics, lateStt, null, 36, lateEnvelope, { granularity: 'sentences' });
const lateFirst = late.lines[0];
check('late single anchor does not crush the prefix', lateFirst.start < 25, true);
check('prefix keeps readable line durations', lateFirst.end - lateFirst.start > 0.3, true);

// a track with no recognizer words at all must be flagged rather than silently presented as synced
const empty = lyricsService.alignPastedLyricsToAudio(lyrics, [], null, duration, envelope, { granularity: 'sentences' });
check('no recognizer words -> estimated', empty.estimated, true);

// lyric-locked shader motion reads lineAge / nextIn / nextLineStart, so the frame has to report the
// next line's start even between lines, and -1-style "no next line" rather than Infinity
const frameLyrics = {
  lines: [
    { text: 'first line', start: 1.0, end: 3.0, words: [{ text: 'first', start: 1.0, end: 2.0 }, { text: 'line', start: 2.0, end: 3.0 }] },
    { text: 'second line', start: 5.0, end: 7.0, words: [{ text: 'second', start: 5.0, end: 6.0 }, { text: 'line', start: 6.0, end: 7.0 }] }
  ]
};
const onLine = lyricsService.getLyricsFrameAt(frameLyrics, 2.0);
check('frame: active line index', onLine.activeLineIndex, 0);
check('frame: progress through line', Math.round(onLine.progress * 100) / 100, 0.5);
check('frame: line age from first word', onLine.lineAge, 1);
check('frame: next line start', onLine.nextLineStart, 5);
check('frame: next in seconds', onLine.nextIn, 3);

const betweenLines = lyricsService.getLyricsFrameAt(frameLyrics, 3.5);
check('gap: no active line', betweenLines.activeLineIndex, -1);
check('gap: still reports next line start', betweenLines.nextLineStart, 5);
check('gap: still reports next in', betweenLines.nextIn, 1.5);
check('gap: line age is zero', betweenLines.lineAge, 0);

const afterLast = lyricsService.getLyricsFrameAt(frameLyrics, 9.0);
check('after last: no next line start', afterLast.nextLineStart, null);
check('after last: no next in', afterLast.nextIn, null);

// travel is the only lyric coordinate safe to add to a phase: it must never decrease, and it must
// hold still through a gap instead of scaling back
const travelAt = (t) => lyricsService.getLyricsFrameAt(frameLyrics, t).travel;
const travelSamples = [];
for (let t = 0; t <= 9; t += 0.25) travelSamples.push(travelAt(t));
check('travel: never decreases', travelSamples.every((v, i) => i === 0 || v >= travelSamples[i - 1] - 1e-9), true);
check('travel: zero before the first line', travelAt(0.5), 0);
check('travel: holds through the gap', travelAt(3.5) === travelAt(4.5), true);
check('travel: advances during a line', travelAt(2) > travelAt(1.25), true);
check('travel: one unit per finished line', Math.round(travelAt(3.2) * 100) / 100, 1);
check('travel: two lines by the end', Math.round(travelAt(9) * 100) / 100, 2);

// a one-word fragment cannot carry a full phrase's accent: the same amplitude over 0.4s is a whip
const fragments = {
  lines: [
    { text: 'Plenty of the men tryna get in', start: 1.0, end: 3.0, words: [] },
    { text: 'the bed.', start: 3.4, end: 3.8, words: [] }
  ]
};
const frameAt = (t) => lyricsService.getLyricsFrameAt(fragments, t);
check('weight: a 2s phrase carries the full move', frameAt(2.0).lineWeight, 1);
check('weight: a 0.4s fragment is capped small', frameAt(3.5).lineWeight <= 0.35, true);
check('weight: duration is reported in seconds', frameAt(3.5).lineDuration, 0.4);
check('weight: a fragment is not a full phrase', frameAt(3.5).lineWeight < frameAt(2.0).lineWeight, true);
check('weight: neutral in a gap', frameAt(4.5).lineWeight, 1);

// connect words: the last sung line holds through the gap instead of clearing
const holdFixture = {
  lines: [
    { text: 'first line holds', start: 1.0, end: 2.0, words: [
      { text: 'first', start: 1.0, end: 1.3 },
      { text: 'line', start: 1.3, end: 1.6 },
      { text: 'holds', start: 1.6, end: 2.0 }
    ] },
    { text: 'second line', start: 5.0, end: 6.0, words: [
      { text: 'second', start: 5.0, end: 5.5 },
      { text: 'line', start: 5.5, end: 6.0 }
    ] }
  ]
};
const holdOn = { ...holdFixture, holdLines: true };
const holdFrame = (data, t) => lyricsService.getLyricsFrameAt(data, t);

check('connect: gap clears by default', holdFrame(holdFixture, 3.0).activeLineIndex, -1);
check('connect: gap holds when enabled', holdFrame(holdOn, 3.0).activeLineIndex, 0);
check('connect: held line keeps its text', holdFrame(holdOn, 3.0).line, 'first line holds');
check('connect: held line is marked', holdFrame(holdOn, 3.0).held, true);
check('connect: held progress is complete', holdFrame(holdOn, 3.0).progress, 1);
check('connect: no word is active while held', holdFrame(holdOn, 3.0).activeWordIndex, -1);
check('connect: heldFor counts the hold', holdFrame(holdOn, 3.0).heldFor, 0.88);
check('connect: next line takes over', holdFrame(holdOn, 5.2).line, 'second line');
check('connect: next line is not held', holdFrame(holdOn, 5.2).held, false);
check('connect: last line holds to the end', holdFrame(holdOn, 8.0).line, 'second line');
check('connect: hold is off by default', holdFrame(holdFixture, 3.0).heldFor, 0);

console.log(failures === 0 ? '\nRESULT: PASS' : `\nRESULT: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
