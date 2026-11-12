const { fetchAnimeClips, loadCatalog } = require('./animeFetcher');

(async () => {
  console.log('Seeding melancholic anime clips (characters + city/beach/stairs + scenery)...');
  const existing = loadCatalog();
  if (existing.length >= 6) {
    console.log(`Already have ${existing.length} clips in library.`);
    return;
  }
  const res = await fetchAnimeClips({ category: 'all', count: 8 });
  console.log(`Downloaded ${res.added.length} clips. Total in library: ${res.catalog.length}`);
  for (const c of res.catalog) {
    console.log(` - [${c.vibe}${c.hasCharacter ? ' + character' : ''}] ${c.title} (${c.filename})`);
  }
})();

