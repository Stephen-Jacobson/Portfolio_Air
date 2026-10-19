// Builds the nav bar from every element with a data-nav="Label" attribute
// (that element needs an id). Highlights the link of the section in view.
(function () {
  const nav = document.getElementById('site-nav');
  if (!nav) return;
  const targets = [...document.querySelectorAll('[data-nav][id]')];
  const links = new Map();

  targets.forEach((el) => {
    const a = document.createElement('a');
    a.href = '#' + el.id;
    a.textContent = el.dataset.nav;
    nav.appendChild(a);
    links.set(el, a);
  });

  function setActive() {
    // The active section is the last one whose top has passed the upper third.
    const line = window.innerHeight * 0.33;
    let current = targets[0];
    targets.forEach((el) => { if (el.getBoundingClientRect().top <= line) current = el; });
    // At the very bottom of the page, light up the last link.
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) {
      current = targets[targets.length - 1];
    }
    links.forEach((a, el) => a.classList.toggle('active', el === current));
    const act = nav.querySelector('a.active');
    if (act && nav.scrollWidth > nav.clientWidth) {
      nav.scrollTo({ left: act.offsetLeft - nav.clientWidth / 2 + act.offsetWidth / 2, behavior: 'smooth' });
    }
  }
  window.addEventListener('scroll', setActive, { passive: true });
  window.addEventListener('resize', setActive);
  setActive();
})();