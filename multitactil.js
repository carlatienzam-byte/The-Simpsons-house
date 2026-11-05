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
    if (!t) return;
    var canvas = this.el.sceneEl.canvas;
    var deltaY = 2 * Math.PI * (t.pageX - this.touchStart.x) / canvas.clientWidth;
    var direction = this.data.reverseTouchDrag ? 1 : -1;
    this.yawObject.rotation.y -= deltaY * 0.5 * direction;   // igual que A-Frame: solo giro horizontal
    this.touchStart = {x: t.pageX, y: t.pageY};
  };

  P.onTouchEnd = function (evt) {
    // solo termina si se ha levantado el dedo que movía la vista
    if (!evt || !evt.changedTouches || buscar(evt.changedTouches, this.dedoVista)) {
      this.touchStarted = false;
      this.dedoVista = null;
    }
  };
})();
