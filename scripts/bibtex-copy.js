(function () {
  const btn = document.getElementById('bibtexCopyBtn');
  const pre = document.getElementById('bibtexsec');
  if (!btn || !pre) return;

  btn.addEventListener('click', async () => {
    const text = pre.textContent.trim();
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
    const originalContent = btn.textContent;
    btn.textContent = '✓';
    setTimeout(() => {
      btn.textContent = originalContent;
    }, 1500);
  });
})();
