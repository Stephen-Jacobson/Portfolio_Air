function updateHeroMask() {
  const title = document.querySelector('.hero-title');
  const maskEl = document.querySelector('.hero-title-mask');
  if (!title || !maskEl) return;

  const rect = title.getBoundingClientRect();
  const style = getComputedStyle(title);
  const dpr = window.devicePixelRatio || 1;

  // Draw the real text onto an offscreen canvas, white-on-transparent,
  // using the exact same font the CSS is using — this becomes the mask shape.
  const canvas = document.createElement('canvas');
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#fff';
  ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText(title.textContent.trim(), rect.width / 2, rect.height / 2);

  const dataUrl = canvas.toDataURL();

  maskEl.style.left = rect.left + 'px';
  maskEl.style.top = rect.top + 'px';
  maskEl.style.width = rect.width + 'px';
  maskEl.style.height = rect.height + 'px';
  maskEl.style.webkitMaskImage = `url(${dataUrl})`;
  maskEl.style.maskImage = `url(${dataUrl})`;
  maskEl.style.webkitMaskSize = '100% 100%';
  maskEl.style.maskSize = '100% 100%';
}

window.addEventListener('load', updateHeroMask);
window.addEventListener('resize', updateHeroMask);