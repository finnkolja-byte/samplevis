// the regroup pass is a proposal, never a rewrite: these cases pin what it will merge, what it
// refuses to merge, and that it leaves the caller's lyrics object untouched
global.window = {};
require('../public/js/services/lyricsService.js');
const lyricsService = global.window.lyricsService;

let failures = 0;
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures += 1;
  console.log(`${pass ? 'pass' : 'FAIL'}  ${label.padEnd(56)} got=${JSON.stringify(actual)} want=${JSON.stringify(expected)}`);
}

function line(text, start, step = 0.3) {
  const tokens = String(text).split(/\s+/).filter(Boolean);
  return {
    text,
    start,
    end: Number((start + tokens.length * step).toFixed(3)),
    words: tokens.map((t, i) => ({
      text: t,
      start: Number((start + i * step).toFixed(3)),
      end: Number((start + i * step + step * 0.8).toFixed(3))
    }))
  };
}

function lyricsOf(lines) {
  return { mode: 'pasted', granularity: 'sentences', rawText: lines.map((l) => l.text).join('\n'), lines };
}

// the real defect: a one-word tail on its own line, and a line carrying two sentences
const bad = lyricsOf([
  line('Sly. Plenty of the men tryna get in', 1.0),
  line('the bed.', 3.7),
  line('and then we drifted', 7.2)
]);
const regrouped = lyricsService.regroupLyricPhrases(bad);
const after = regrouped.preview.after;

check('regroup: reports a change', regrouped.changed, true);
check('regroup: three lines before', regrouped.preview.linesBefore, 3);
check('regroup: three lines after (regrouped, not dropped)', regrouped.preview.linesAfter, 3);
check('regroup: splits the two-sentence line', after[0].text, 'Sly.');
check('regroup: merges the tail into its sentence', after[1].text, 'Plenty of the men tryna get in the bed.');
check('regroup: merged line word count', after[1].words, 9);
check('regroup: merged line carries the full accent', after[1].weight, 1);
check('regroup: untouched line survives', after[2].text, 'and then we drifted');
check('regroup: ops are previewable', regrouped.preview.ops.map((op) => op.type), ['split', 'merge']);
check('regroup: output is sentence mode', regrouped.lyrics.granularity, 'sentences');
check('regroup: output no longer claims the pasted grouping', regrouped.lyrics.mode, 'regrouped');
check('regroup: source object untouched', bad.lines[0].text, 'Sly. Plenty of the men tryna get in');
check('regroup: source word list untouched', bad.lines[0].words.length, 8);
check('regroup: words keep their times', regrouped.lyrics.lines[1].words[0].start, 1.3);
check('regroup: short line is flagged, not hidden', regrouped.preview.shortLines, 1);
check('regroup: sources report the weight they had', regrouped.preview.after[1].sources.every((s) => typeof s.weight === 'number'), true);

// a deliberate short sentence is not a fragment
const stinger = lyricsService.regroupLyricPhrases(lyricsOf([
  line('and then we drifted', 1.0),
  line('Sly.', 2.4)
]));
check('stinger: complete sentence stays separate', stinger.preview.after.length, 2);
check('stinger: no merge op', stinger.preview.ops.filter((op) => op.type === 'merge').length, 0);

// a long pause means two phrases, not one ran-on line
const pause = lyricsService.regroupLyricPhrases(lyricsOf([
  line('we were running', 1.0),
  line('through the field at night', 4.0)
]));
check('pause: fragment after a long gap is not merged', pause.preview.after.length, 2);
check('pause: gap rule is what kept them apart', pause.preview.after[1].text, 'through the field at night');

// a finished sentence does not absorb the next fragment
const finished = lyricsService.regroupLyricPhrases(lyricsOf([
  line('we waited.', 1.0),
  line('the bed.', 1.6)
]));
check('terminal: no merge after a finished sentence', finished.preview.after.length, 2);

// a lowercase continuation is a fragment even at four words
const continuation = lyricsService.regroupLyricPhrases(lyricsOf([
  line('we were running', 1.0),
  line('through the field at night', 2.6)
]));
check('continuation: lowercase line merges', continuation.preview.after.length, 1);
check('continuation: merged text', continuation.preview.after[0].text, 'we were running through the field at night');

// an overlong line with no sentence boundary is left alone rather than guessed at
const noBoundary = lyricsService.regroupLyricPhrases(lyricsOf([
  line('we were running through the field at night and never looking back again', 1.0)
]));
check('no boundary: overlong line stays whole', noBoundary.changed, false);

// already-sane grouping is a no-op
const sane = lyricsService.regroupLyricPhrases(lyricsOf([
  line('we were running through the field.', 1.0),
  line('and never looking back.', 3.0)
]));
check('sane: no change reported', sane.changed, false);

check('weight: fragment under 0.3s', lyricsService.computeLineWeight(0.2), 0.15);
check('weight: full phrase at 1.5s', lyricsService.computeLineWeight(1.5), 1);

// the preview and the live frame must agree on weight, or the preview lies about the emphasis
const weightFrame = lyricsService.getLyricsFrameAt(lyricsOf([line('a whole phrase here', 1.0, 0.1)]), 1.2);
check('weight: a fast line is not a full accent', weightFrame.lineWeight < 0.5, true);
check('weight: preview matches live frame', weightFrame.lineWeight, lyricsService.computeLineWeight(weightFrame.lineDuration));

console.log(failures === 0 ? '\nRESULT: PASS' : `\nRESULT: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
