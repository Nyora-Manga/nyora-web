  (function () {
    var NEW_ORIGIN = 'https://web.nyora.xyz';
    var OLD_HOSTS = ['nyora.xyz', 'nyoramanga.hasanraza.tech'];
    var isNyoraKey = function (k) {
      return !!k && (k.lastIndexOf('nyora.', 0) === 0 || k.lastIndexOf('nyora:', 0) === 0);
    };
    // Merge two nyora.library.v1 blobs (favourites/history/bookmarks/…) so the
    // incoming library adds to any library already on this origin instead of
    // being dropped. History entries resolve by newest updatedAt.
    var mergeLib = function (curStr, incStr) {
      var cur = {}, inc = {};
      try { cur = JSON.parse(curStr) || {}; } catch (e) {}
      try { inc = JSON.parse(incStr) || {}; } catch (e) { return curStr; }
      ['favourites', 'history', 'categories', 'categoryMembers', 'prefs', 'snapshots'].forEach(function (b) {
        var c = (cur[b] && typeof cur[b] === 'object' && !Array.isArray(cur[b])) ? cur[b] : {};
        var i = (inc[b] && typeof inc[b] === 'object' && !Array.isArray(inc[b])) ? inc[b] : {};
        var out = {}, k;
        for (k in c) out[k] = c[k];
        for (k in i) {
          if (b === 'history' && out[k] && (Number(out[k].updatedAt) || 0) >= (Number(i[k].updatedAt) || 0)) continue;
          out[k] = i[k];
        }
        cur[b] = out;
      });
      var arr = (Array.isArray(cur.bookmarks) ? cur.bookmarks : []).concat(Array.isArray(inc.bookmarks) ? inc.bookmarks : []);
      var seen = {}, merged = [];
      arr.forEach(function (bm) { var id = bm && bm.id != null ? String(bm.id) : JSON.stringify(bm); if (!seen[id]) { seen[id] = 1; merged.push(bm); } });
      cur.bookmarks = merged;
      cur.seq = Math.max(Number(cur.seq) || 1, Number(inc.seq) || 1);
      try { return JSON.stringify(cur); } catch (e) { return curStr; }
    };
    try {
      if (location.origin !== NEW_ORIGIN && OLD_HOSTS.indexOf(location.hostname) !== -1) {
        // OLD domain: dump every nyora.* localStorage key, then hard-redirect to
        // the new domain with the data in the URL fragment (fragments are never
        // sent to the server, so no URL-length limit at the edge).
        var dump = {};
        try {
          for (var i = 0; i < localStorage.length; i++) {
            var k = localStorage.key(i);
            if (isNyoraKey(k)) dump[k] = localStorage.getItem(k);
          }
        } catch (e) {}
        // Never put credentials in a URL. The fragment isn't sent to a server,
        // but it does transit the address bar, session-restore state, and any
        // extension with tab access — so drop the LLM API key and the sync
        // token from the payload. Both are re-entered/re-issued on the new
        // origin; everything else (library, history, prefs) still migrates.
        try { delete dump['nyora.sync.session.v1']; } catch (e) {}
        try {
          if (dump['nyora.prefs']) {
            var pj = JSON.parse(dump['nyora.prefs']);
            if (pj && pj.aiApiKey) { pj.aiApiKey = ''; dump['nyora.prefs'] = JSON.stringify(pj); }
          }
        } catch (e) {}
        var frag = '';
        try {
          var b64 = btoa(unescape(encodeURIComponent(JSON.stringify(dump))));
          // URL-encode so browsers that percent-encode +,/,= in the fragment
          // can't corrupt the base64 on the way to the new origin.
          if (b64.length <= 1900000) frag = '#__m=' + encodeURIComponent(b64); // guard against extreme URLs
        } catch (e) {}
        location.replace(NEW_ORIGIN + '/' + frag);
        // Hide the page while the redirect is in flight.
        document.documentElement.style.visibility = 'hidden';
        return;
      }
      // NEW domain: if a migration payload arrived, import the keys we don't
      // already have (don't clobber data created on this origin), then strip it.
      if (location.hash.indexOf('#__m=') === 0) {
        try {
          var data = JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(location.hash.slice(5))))));
          for (var key in data) {
            if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
            var cur = localStorage.getItem(key);
            if (cur == null) localStorage.setItem(key, data[key]);
            else if (key === 'nyora.library.v1') localStorage.setItem(key, mergeLib(cur, data[key]));
            // other keys: keep this origin's existing value (don't clobber prefs)
          }
        } catch (e) {}
        try { history.replaceState(null, '', location.origin + location.pathname); } catch (e) {}
      }
    } catch (e) {}
  })();
