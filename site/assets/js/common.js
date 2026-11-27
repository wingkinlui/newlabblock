/* Shared helpers for every page: manifest loading + the photo lightbox. */

/** Fetch the generated asset manifest. */
export async function loadManifest() {
  const res = await fetch('assets/manifest.json');
  if (!res.ok) throw new Error(`manifest.json: ${res.status}`);
  return res.json();
}

/** Human readable byte size. */
export function formatBytes(bytes) {
  if (!bytes) return '-';
  const mb = bytes / 1024 / 1024;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/** Format a metre value for display. */
export function formatMetres(value) {
  return value >= 10 ? `${value.toFixed(1)} m` : `${value.toFixed(2)} m`;
}

/**
 * Wire up a click-to-zoom lightbox for every [data-lightbox] image.
 *
 * The group is scoped to the nearest container so the floor-plan page and the
 * snapshot page each get their own previous/next navigation.
 */
export function initLightbox(groupSelector = '.card-grid') {
  const groups = [...document.querySelectorAll(groupSelector)];
  let box = document.querySelector('.lightbox');

  if (!box) {
    box = document.createElement('div');
    box.className = 'lightbox';
    box.innerHTML = `
      <div class="lb-top">
        <div class="lb-title"></div>
        <button class="icon-btn lb-close" title="Close (Esc)">&times;</button>
      </div>
      <div class="lb-stage"><img alt=""></div>
      <div class="lb-nav">
        <button class="lb-btn lb-prev">&larr; Previous</button>
        <button class="lb-btn lb-next">Next &rarr;</button>
      </div>`;
    document.body.appendChild(box);
  }

  const img = box.querySelector('img');
  const title = box.querySelector('.lb-title');
  let items = [];
  let index = 0;

  function show(i) {
    index = (i + items.length) % items.length;
    const item = items[index];
    img.src = item.full;
    img.alt = item.title;
    title.textContent = `${item.title}  (${index + 1} / ${items.length})`;
  }

  function open(i) {
    box.classList.add('open');
    document.body.style.overflow = 'hidden';
    show(i);
  }

  function close() {
    box.classList.remove('open');
    document.body.style.overflow = '';
  }

  groups.forEach((group) => {
    const cards = [...group.querySelectorAll('[data-lightbox]')];
    items = cards.map((card) => {
      const thumb = card.querySelector('img');
      return {
        full: card.dataset.lightbox,
        title: card.dataset.title || thumb?.alt || 'Photo',
      };
    });

    cards.forEach((card, i) => {
      card.addEventListener('click', () => open(i));
      card.setAttribute('tabindex', '0');
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open(i);
        }
      });
    });
  });

  box.querySelector('.lb-close').addEventListener('click', close);
  box.querySelector('.lb-prev').addEventListener('click', () => show(index - 1));
  box.querySelector('.lb-next').addEventListener('click', () => show(index + 1));
  box.addEventListener('click', (e) => {
    if (e.target === box) close();
  });

  document.addEventListener('keydown', (e) => {
    if (!box.classList.contains('open')) return;
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowLeft') show(index - 1);
    if (e.key === 'ArrowRight') show(index + 1);
  });
}

/** Render the standard footer year. */
export function initFooter() {
  const el = document.querySelector('[data-year]');
  if (el) el.textContent = String(new Date().getFullYear());
}
