/* @ds-bundle: {"format":4,"namespace":"Forseti","components":[{"name":"Seal"},{"name":"Logo"}]} */
(function () {
  // The Forseti mark: a seal with three notches in its ring (the appeal panel) and an F cut from
  // a vertical bar (the locked commitment). Drawn on a 64-unit grid.
  var F = 'M25.5 17h15v5h-10v7h8v5h-8v13h-5z';
  function ring(cx, r, w, gaps, rot) {
    // a circle of stroke width w with three gaps of `gaps` degrees, 120° apart, rotated by rot
    var out = '', step = 120, seg = step - gaps;
    for (var k = 0; k < 3; k++) {
      var a0 = (rot + k * step + gaps / 2 - 90) * Math.PI / 180, a1 = a0 + seg * Math.PI / 180;
      var x0 = cx + r * Math.cos(a0), y0 = cx + r * Math.sin(a0), x1 = cx + r * Math.cos(a1), y1 = cx + r * Math.sin(a1);
      out += '<path d="M' + x0.toFixed(2) + ' ' + y0.toFixed(2) + 'A' + r + ' ' + r + ' 0 0 1 ' + x1.toFixed(2) + ' ' + y1.toFixed(2) + '" fill="none" stroke-width="' + w + '" stroke-linecap="butt"/>';
    }
    return out;
  }
  function mark(opts) {
    opts = opts || {};
    var size = opts.size || 48, label = opts.title || 'Forseti';
    return '<svg class="fs-mark" viewBox="0 0 64 64" width="' + size + '" height="' + size + '" role="img" aria-label="' + label + '">' +
      '<g class="fs-ink" stroke="currentColor">' + ring(32, 28, 4.5, 16, 0) + '</g>' +
      '<path class="fs-ink" fill="currentColor" d="' + F + '"/></svg>';
  }
  function bytes(hex) {
    var h = String(hex || '').replace(/^0x/, '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(h)) throw new Error('Forseti.seal needs a 32-byte hex hash');
    var b = [];
    for (var i = 0; i < 64; i += 2) b.push(parseInt(h.slice(i, i + 2), 16));
    return b;
  }
  // A market's seal: the same 32 bytes always draw the same seal. The edge is 64 serrations, one per
  // nibble of the hash (length from its value); byte 0 turns the panel ring. State changes the shape:
  // proposed dashes the inner ring (still open to appeal), disputed seats the three panel dots.
  function impression(b, cls, state) {
    var ticks = '';
    for (var i = 0; i < 64; i++) {
      var n = i % 2 ? b[i >> 1] & 15 : b[i >> 1] >> 4;
      var a = (i * 360 / 64 - 90) * Math.PI / 180, r0 = 39, r1 = 41 + n * 0.32;
      ticks += '<line x1="' + (50 + r0 * Math.cos(a)).toFixed(2) + '" y1="' + (50 + r0 * Math.sin(a)).toFixed(2) + '" x2="' + (50 + r1 * Math.cos(a)).toFixed(2) + '" y2="' + (50 + r1 * Math.sin(a)).toFixed(2) + '" stroke-width="1.5"/>';
    }
    var rot = b[0] * 360 / 256, seats = '';
    if (state === 'disputed') {
      for (var k = 0; k < 3; k++) {
        var t = (rot + k * 120 - 90) * Math.PI / 180;
        seats += '<circle cx="' + (50 + 32 * Math.cos(t)).toFixed(2) + '" cy="' + (50 + 32 * Math.sin(t)).toFixed(2) + '" r="2.6" fill="currentColor" stroke="none"/>';
      }
    }
    var inner = '<circle cx="50" cy="50" r="25.5" fill="none" stroke-width="1.2"' + (state === 'proposed' ? ' stroke-dasharray="2.4 2.2"' : '') + '/>';
    return '<g class="' + cls + '" stroke="currentColor">' + ticks +
      '<circle cx="50" cy="50" r="47.5" fill="none" stroke-width="1"/><circle cx="50" cy="50" r="37" fill="none" stroke-width="1"/>' +
      ring(50, 32, 2.6, 16, rot) + seats + inner + '</g>' +
      '<path class="' + cls + '" fill="currentColor" transform="translate(30 30.5) scale(0.61)" d="' + F + '"/>';
  }
  var STATES = { open: 'Open', proposed: 'Verdict proposed', disputed: 'Before the panel', final: 'Final', overturned: 'Overturned' };
  function seal(hash, opts) {
    opts = opts || {};
    var state = STATES[opts.state] ? opts.state : 'open', size = opts.size || 96, b = bytes(hash);
    var ghost = '';
    if (state === 'overturned') {
      // the old impression stays faintly visible under the new one
      ghost = '<g transform="rotate(-11 50 50) translate(-3 2)" opacity="0.3">' + impression(b, 'fs-seal-old', 'open') + '</g>';
    }
    var disc = state === 'final' || state === 'overturned' ? '<circle class="fs-seal-disc" cx="50" cy="50" r="46"/>' : '';
    var label = opts.title || ('Seal of commitment 0x' + String(hash).replace(/^0x/, '').slice(0, 8) + '…, ' + STATES[state]);
    return '<svg class="fs-seal fs-seal-' + state + '" viewBox="0 0 100 100" width="' + size + '" height="' + size + '" role="img" aria-label="' + label + '">' +
      disc + ghost + impression(b, 'fs-seal-ink', state) + '</svg>';
  }
  window.Forseti = { seal: seal, mark: mark, states: Object.keys(STATES) };
})();
