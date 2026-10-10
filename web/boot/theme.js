  (function () {
    try {
      var p = JSON.parse(localStorage.getItem('nyora.prefs') || '{}');
      var a = p.appearance || 'DARK';
      var t = a === 'LIGHT' ? 'LIGHT'
        : a === 'DARK' ? 'DARK'
        : (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'LIGHT' : 'DARK');
      document.documentElement.setAttribute('data-theme', t);
    } catch (e) { document.documentElement.setAttribute('data-theme', 'DARK'); }
  })();
