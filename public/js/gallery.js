(async function () {
  'use strict';

  const grid = document.getElementById('galleryGrid');
  const tabs = document.querySelectorAll('.gallery-tab-btn');
  let currentFilter = 'all';

  // sync presets from disk/indexeddb
  if (window.presetService) {
    try {
      await window.presetService.syncWithBackend();
    } catch (err) {
      console.warn('[Gallery] Sync failed:', err);
    }
  }

  function renderGrid() {
    if (!grid) return;
    grid.innerHTML = '';

    // 1. "create new preset" card
    const createCard = document.createElement('div');
    createCard.className = 'gallery-card new-preset-card';
    createCard.innerHTML = `
      <div class="new-preset-icon">+</div>
      <div class="new-preset-title">new blank preset</div>
      <div class="new-preset-desc">create an empty 3-box visualizer template ready for custom code or ai generation.</div>
    `;
    createCard.addEventListener('click', () => {
      window.open('/?preset=new_blank', '_blank');
    });
    grid.appendChild(createCard);

    // 2. get all registered templates from templateRegistry
    const allTemplates = window.templateRegistry ? window.templateRegistry.getAll() : [];

    const filtered = allTemplates.filter((tpl) => {
      const isCustom = tpl.badge === 'Custom' || Boolean(tpl.isCustom);
      if (currentFilter === 'templates') return !isCustom;
      if (currentFilter === 'saved') return isCustom;
      return true;
    });

    filtered.forEach((tpl) => {
      const isCustom = tpl.badge === 'Custom' || Boolean(tpl.isCustom);
      const card = document.createElement('a');
      card.className = 'gallery-card';
      card.href = `/?preset=${encodeURIComponent(tpl.id)}`;
      card.target = '_blank';
      card.innerHTML = `
        <div class="gallery-card-header">
          <span class="gallery-card-title">${tpl.name || tpl.id}</span>
          <span class="gallery-card-badge">${tpl.badge || (isCustom ? 'saved' : 'template')}</span>
        </div>
        <div class="gallery-card-desc">${tpl.tagline || tpl.preset?.meta?.description || '3-box audio & visual reel preset.'}</div>
        <div class="gallery-card-footer">
          <span class="card-meta-tag">${isCustom ? 'local disk project' : 'built-in engine'}</span>
          <span class="gallery-card-btn">open in editor ↗</span>
        </div>
      `;
      grid.appendChild(card);
    });
  }

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      currentFilter = tab.dataset.filter;
      renderGrid();
    });
  });

  renderGrid();
})();

