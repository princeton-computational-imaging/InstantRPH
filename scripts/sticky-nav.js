(function () {
  const nav = document.getElementById('sticky-nav');
  if (!nav) return;

  const links = nav.querySelectorAll('.sticky-nav-link');
  const sectionIds = Array.from(links).map((link) => link.getAttribute('href').slice(1));
  const header = document.getElementById('header');

  function updateNav() {
    const threshold = header ? header.offsetTop + header.offsetHeight : 300;
    nav.classList.toggle('visible', window.scrollY > threshold);

    let current = '';
    for (const id of sectionIds) {
      const el = document.getElementById(id);
      if (el && el.getBoundingClientRect().top <= 80) current = id;
    }
    links.forEach((link) => link.classList.toggle('active', link.getAttribute('href') === '#' + current));
  }

  window.addEventListener('scroll', updateNav, { passive: true });
  updateNav();

  links.forEach((link) => {
    link.addEventListener('click', function (e) {
      e.preventDefault();
      const target = document.getElementById(this.getAttribute('href').slice(1));
      if (target) {
        const offset = 60;
        const top = target.getBoundingClientRect().top + window.scrollY - offset;
        window.scrollTo({ top, behavior: 'smooth' });
      }
    });
  });
})();
