const assert = require('assert');
const { parseSampleFilename: parseBackend } = require('../src/parsers/audioAnalyzer');
const fs = require('fs');

// Extract client parser from public/js/clientAnalyzer.js
const clientCode = fs.readFileSync('public/js/clientAnalyzer.js', 'utf8');
const clientFnMatch = clientCode.match(/function parseSampleFilename\(filename\) \{[\s\S]*?\n  \}/);
if (!clientFnMatch) {
  throw new Error('Could not extract client parseSampleFilename');
}
const parseClient = new Function(`return (${clientFnMatch[0]})`)();

console.log('Testing filename parser parity and edge cases...');

const testCases = [
  {
    input: '#1 - meadows - bmaj - 132bpm.wav',
    expected: { sampleNumber: '001', title: 'meadows', key: 'Bmaj', bpm: 132 }
  },
  {
    input: '04 - Tokyo Drift_140BPM_F# Minor.wav',
    expected: { sampleNumber: '004', title: 'tokyo drift', key: 'F#min', bpm: 140 }
  },
  {
    input: 'guitar_loop_95bpm_c#m.wav',
    expected: { sampleNumber: null, title: 'guitar loop', key: 'C#min', bpm: 95 }
  },
  {
    input: 'ambient_pad_intro.wav',
    expected: { sampleNumber: null, title: 'ambient pad intro', key: null, bpm: null }
  },
  {
    input: '012 - Sunset - Ab major - 128 bpm.wav',
    expected: { sampleNumber: '012', title: 'sunset', key: 'Abmaj', bpm: 128 }
  },
  {
    input: 'LoFi_Chords_Bbm_75.wav',
    expected: { sampleNumber: null, title: 'lofi chords', key: 'Bbmin', bpm: 75 }
  }
];

testCases.forEach(({ input, expected }, idx) => {
  const resBackend = parseBackend(input);
  const resClient = parseClient(input);

  console.log(`[Test ${idx + 1}] "${input}"`);
  console.log('  backend:', resBackend);
  console.log('  client: ', resClient);

  assert.deepStrictEqual(resBackend, expected, `Backend failed for "${input}"`);
  assert.deepStrictEqual(resClient, expected, `Client failed for "${input}"`);
});

console.log('\nAll filename parser parity tests passed successfully!');

