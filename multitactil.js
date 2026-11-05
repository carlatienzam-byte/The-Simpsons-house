/* ════════════════════════════════════════════════════════════════════
   MULTITÁCTIL  ·  Proyecto Colombine
   ────────────────────────────────────────────────────────────────────
   Cárgalo justo después de A-Frame (antes de <a-scene>).

   Problema que arregla: el control táctil de la cámara de A-Frame
   (look-controls) ignora el giro en cuanto hay MÁS DE UN dedo en la
   pantalla. Si mantienes ▲ / ▼ o el joystick con un dedo y arrastras
   con otro para mirar, la cámara parecía "bloqueada".

   Ahora la cámara sigue únicamente al dedo que empezó a arrastrar sobre
   la escena, aunque haya otros dedos pulsando botones o el joystick.
   (Para el joystick, el index.html usa e.targetTouches[0]: el dedo que
   empezó sobre el propio joystick.)
   ════════════════════════════════════════════════════════════════════ */
(function () {
  if (!window.AFRAME || !AFRAME.components['look-controls']) return;
  var P = AFRAME.components['look-controls'].Component.prototype;

  function buscar(lista, id) {
    for (var i = 0; i < lista.length; i++) if (lista[i].identifier === id) return lista[i];
    return null;
  }

  P.onTouchStart = function (evt) {
    if (!this.data.touchEnabled || this.el.sceneEl.is('vr-mode') || this.el.sceneEl.is('ar-mode')) return;
    // Si el dedo que movía la vista ya no está en la pantalla (toque cancelado
    // por el navegador, p. ej. en una pulsación larga), se libera.
    if (this.touchStarted && !buscar(evt.touches, this.dedoVista)) { this.touchStarted = false; this.dedoVista = null; }
    if (this.touchStarted) return;                 // ya hay un dedo girando la vista
    var t = evt.changedTouches[0];                 // el dedo que acaba de tocar la escena
    if (!t) return;
    this.dedoVista = t.identifier;
    this.touchStart = {x: t.pageX, y: t.pageY};
    this.touchStarted = true;
  };

  P.onTouchMove = function (evt) {
    if (!this.touchStarted || !this.data.touchEnabled) return;
    var t = buscar(evt.touches, this.dedoVista);
    if (!t) { this.touchStarted = false; this.dedoVista = null; return; }   // dedo perdido: liberar
    var canvas = this.el.sceneEl.canvas;
    var deltaY = 2 * Math.PI * (t.pageX - this.touchStart.x) / canvas.clientWidth;
    var direction = this.data.reverseTouchDrag ? 1 : -1;
    this.yawObject.rotation.y -= deltaY * 0.5 * direction;   // igual que A-Frame: solo giro horizontal
    this.touchStart = {x: t.pageX, y: t.pageY};
  };

  // A-Frame no escucha "touchcancel": se añade para que un toque cancelado
  // nunca deje la vista bloqueada.
  var addOrig = P.addEventListeners, removeOrig = P.removeEventListeners;
  P.addEventListeners = function () {
    addOrig.apply(this, arguments);
    if (!this._cancelVista) this._cancelVista = this.onTouchEnd;
    window.addEventListener('touchcancel', this._cancelVista, {passive: true});
  };
  P.removeEventListeners = function () {
    removeOrig.apply(this, arguments);
    if (this._cancelVista) window.removeEventListener('touchcancel', this._cancelVista);
  };

  // Si el navegador cancela los toques, soltar también ▲▼ y el joystick
  // (si no, se quedarían "pulsados": subiendo o andando sin parar).
  window.addEventListener('touchcancel', function () {
    if (typeof window.vertDir !== 'undefined') window.vertDir = 0;
    if (typeof window.joyActive !== 'undefined') {
      window.joyActive = false; window.joyDx = 0; window.joyDy = 0;
      var t = document.getElementById('joy-thumb');
      if (t) t.style.transform = 'translate(-50%,-50%)';
    }
    document.querySelectorAll('.vert-btn.pulsado').forEach(function (b) { b.classList.remove('pulsado'); });
  }, {passive: true});

  P.onTouchEnd = function (evt) {
    // solo termina si se ha levantado el dedo que movía la vista
    if (!evt || !evt.changedTouches || buscar(evt.changedTouches, this.dedoVista)) {
      this.touchStarted = false;
      this.dedoVista = null;
    }
  };
})();
