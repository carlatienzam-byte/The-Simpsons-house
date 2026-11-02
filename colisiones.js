/* ════════════════════════════════════════════════════════════════════
   COLISIONES CON LOS MODELOS GLB  ·  Proyecto Colombine
   ────────────────────────────────────────────────────────────────────
   Uso:  <a-entity id="rig" ... colision-malla>
   Requiere cargar antes three-mesh-bvh.min.js (y A-Frame).

   Cómo funciona:
   · Cada vez que un modelo GLB termina de cargar, se organiza su malla
     en un árbol (BVH) para poder comprobar choques casi sin coste.
     Se hace de uno en uno, repartido entre fotogramas, para no congelar.
   · En cada fotograma se mira cuánto se ha movido la cámara (joystick,
     teclado o caminando con las gafas). Si en ese camino hay una pared a
     la altura de las rodillas o del pecho, el visitante se detiene o
     se desliza a lo largo de la pared.
   · Los saltos grandes (portales, cambio de mundo) no se comprueban.
   · Solo frenan las superficies empinadas: el suelo, las rampas y las
     ondulaciones del terreno nunca atrapan al visitante.
   · Para que un modelo NO choque (hierba, flores, cielo...), añade el
     atributo  sin-colision  a su entidad.
   · Los cielos enormes y los personajes animados se ignoran solos.
   ════════════════════════════════════════════════════════════════════ */
(function () {
  if (!window.AFRAME || !window.THREE) return;
  var BVH = window.MeshBVHLib && window.MeshBVHLib.MeshBVH;

  AFRAME.registerComponent('colision-malla', {
    schema: {
      radio:   {default: 0.3},        // distancia mínima a la pared (m)
      alturas: {default: '1.0 0.4'},  // alturas de comprobación, en metros por DEBAJO de los ojos
      salto:   {default: 3},          // movimientos mayores (teletransportes) no se comprueban
      pendiente: {default: 0.7},      // superficies más tumbadas que ~45° (suelo, terreno) no bloquean
      maximo:  {default: 150}         // mallas más grandes que esto (cielos) se ignoran
    },

    init: function () {
      this.mallas = [];      // {mesh, inst (índice de instancia o -1)}
      this.cola = [];        // mallas pendientes de preparar
      this.vistos = new WeakSet();
      this.prev = null;
      this.revisar = false;   // comprobar si el visitante ha aparecido encerrado
      this.cam = new THREE.Vector3();
      this.alts = this.data.alturas.split(/\s+/).map(parseFloat).filter(function (v) { return !isNaN(v); });
      // auxiliares reutilizados
      this._ray = new THREE.Ray(); this._lray = new THREE.Ray();
      this._inv = new THREE.Matrix4(); this._mat = new THREE.Matrix4(); this._im = new THREE.Matrix4();
      this._sph = new THREE.Sphere(); this._v = new THREE.Vector3(); this._n = new THREE.Vector3();
      this._nm = new THREE.Matrix3(); this._o = new THREE.Vector3(); this._d = new THREE.Vector3();

      if (!BVH) { console.warn('[colisiones] Falta three-mesh-bvh: colisiones desactivadas'); return; }

      var self = this;
      this.alCargar = function (e) { self.registrar(e.target); };
      this.el.sceneEl.addEventListener('model-loaded', this.alCargar);
      // modelos que ya hubieran cargado antes que este componente
      this.el.sceneEl.querySelectorAll('[gltf-model]').forEach(function (el) { self.registrar(el); });
    },

    remove: function () {
      if (this.alCargar) this.el.sceneEl.removeEventListener('model-loaded', this.alCargar);
    },

    /* ¿Está este elemento dentro del propio jugador o marcado sin colisión? */
    excluido: function (el) {
      for (var e = el; e && e !== this.el.sceneEl; e = e.parentEl) {
        if (e === this.el) return true;
        if (e.hasAttribute && e.hasAttribute('sin-colision')) return true;
      }
      return false;
    },

    registrar: function (el) {
      if (!el || !el.getObject3D) return;
      var raiz = el.getObject3D('mesh');
      if (!raiz || this.vistos.has(raiz) || this.excluido(el)) return;
      this.vistos.add(raiz);
      var self = this;
      raiz.traverse(function (o) {
        if (o.isMesh && !o.isSkinnedMesh && o.geometry && o.geometry.attributes.position) self.cola.push(o);
      });
    },

    /* Prepara (BVH) unas pocas mallas por fotograma */
    preparar: function () {
      var inicio = performance.now();
      if (this.cola.length) this.revisar = true;
      while (this.cola.length && performance.now() - inicio < 8) {
        var m = this.cola.shift(), g = m.geometry;
        try {
          if (!g.boundingSphere) g.computeBoundingSphere();
          m.updateWorldMatrix(true, false);
          var escala = m.matrixWorld.getMaxScaleOnAxis();
          if (g.boundingSphere.radius * escala > this.data.maximo) continue;   // cielo, montañas lejanas…
          if (g.morphAttributes && g.morphAttributes.position && g.morphAttributes.position.length) continue;
          if (!g.boundsTree) g.boundsTree = new BVH(g, {maxLeafTris: 12});
          if (m.isInstancedMesh) {
            for (var i = 0; i < m.count; i++) this.mallas.push({mesh: m, inst: i});
          } else {
            this.mallas.push({mesh: m, inst: -1});
          }
        } catch (err) { /* geometría rara: se ignora */ }
      }
    },

    visible: function (o) {
      for (; o; o = o.parent) if (o.visible === false) return false;
      return true;
    },

    /* Rayo horizontal: devuelve {dist, normal} del primer choque o null */
    lanzar: function (origen, dir, lejos) {
      var mejor = null, mejorD = lejos;
      for (var k = 0; k < this.mallas.length; k++) {
        var it = this.mallas[k], m = it.mesh, g = m.geometry;
        if (it.ignorar) continue;
        var M = m.matrixWorld;
        if (it.inst >= 0) { m.getMatrixAt(it.inst, this._im); M = this._mat.multiplyMatrices(m.matrixWorld, this._im); }
        // filtro rápido con la esfera envolvente
        this._sph.copy(g.boundingSphere).applyMatrix4(M);
        this._v.subVectors(this._sph.center, origen);
        var t = this._v.dot(dir);
        if (t < -this._sph.radius || t > mejorD + this._sph.radius) continue;
        var d2 = this._v.lengthSq() - t * t;
        if (d2 > this._sph.radius * this._sph.radius) continue;
        if (!this.visible(m)) continue;
        // rayo en coordenadas locales de la malla
        this._inv.copy(M).invert();
        this._lray.origin.copy(origen).applyMatrix4(this._inv);
        this._d.copy(origen).addScaledVector(dir, 1).applyMatrix4(this._inv).sub(this._lray.origin);
        var escalaInv = this._d.length();
        if (escalaInv < 1e-9) continue;
        this._lray.direction.copy(this._d).divideScalar(escalaInv);
        var hits = g.boundsTree.raycast(this._lray, THREE.DoubleSide, 0, mejorD * escalaInv);
        if (!hits || !hits.length) continue;
        this._nm.getNormalMatrix(M);
        for (var h = 0; h < hits.length; h++) {
          var dist = hits[h].distance / escalaInv;
          if (dist >= mejorD) continue;
          var nrm = hits[h].face.normal.clone().applyMatrix3(this._nm).normalize();
          // Solo bloquean las superficies empinadas (paredes, muebles, troncos…).
          // Suelos, rampas y ondulaciones del terreno no frenan nunca.
          if (Math.abs(nrm.y) > this.data.pendiente) continue;
          mejorD = dist;
          mejor = {dist: dist, normal: nrm, item: it};
        }
      }
      return mejor;
    },

    /* ¿Se puede ir de "desde" a "hasta" (posición de los ojos)? */
    libre: function (desde, hasta) {
      this._d.subVectors(hasta, desde); this._d.y = 0;
      var dist = this._d.length();
      if (dist < 1e-5) return null;
      var dir = this._d.clone().divideScalar(dist);
      var choque = null;
      for (var a = 0; a < this.alts.length; a++) {
        this._o.set(desde.x, desde.y - this.alts[a], desde.z);
        var h = this.lanzar(this._o, dir, dist + this.data.radio);
        if (h && (!choque || h.dist < choque.dist)) choque = h;
      }
      return choque ? {dir: dir, dist: dist, choque: choque} : null;
    },

    /* Red de seguridad: si al aparecer (o tras un portal) el visitante está
       encerrado por casi todos lados a menos de 1 m, las mallas que lo
       envuelven (terrenos, cúpulas…) dejan de bloquear. Un pasillo nunca
       cumple esto: siempre deja al menos dos direcciones libres. */
    liberar: function (pos) {
      var bloqueadas = 0, culpables = new Map(), o = new THREE.Vector3();
      for (var a = 0; a < 8; a++) {
        var ang = a * Math.PI / 4, dir = new THREE.Vector3(Math.sin(ang), 0, Math.cos(ang)), choque = null;
        for (var h = 0; h < this.alts.length; h++) {
          o.set(pos.x, pos.y - this.alts[h], pos.z);
          var hit = this.lanzar(o, dir, 1.0);
          if (hit && (!choque || hit.dist < choque.dist)) choque = hit;
        }
        if (choque) { bloqueadas++; culpables.set(choque.item.mesh, (culpables.get(choque.item.mesh) || 0) + 1); }
      }
      if (bloqueadas < 7) return;
      var self = this;
      culpables.forEach(function (n, mesh) {
        if (n < 3) return;
        self.mallas.forEach(function (it) { if (it.mesh === mesh) it.ignorar = true; });
        var e = mesh; while (e && !e.el) e = e.parent;
        console.info('[colisiones] el visitante aparecía dentro de "' + (e && e.el ? (e.el.id || e.el.getAttribute('src') || 'modelo') : mesh.name) + '": esa malla deja de bloquear');
      });
    },

    tick: function () {
      this.preparar();
      if (this.revisar && !this.cola.length) {
        this.revisar = false;
        var c = new THREE.Vector3(), camEl = this.el.querySelector('[camera]') || this.el;
        camEl.object3D.getWorldPosition(c);
        this.liberar(c);
      }
      this.resolver();
    },
    tock: function () { this.resolver(); },

    resolver: function () {
      if (!BVH) return;
      var camEl = this.el.querySelector('[camera]') || (this.el.hasAttribute('camera') ? this.el : null);
      if (!camEl) return;
      camEl.object3D.getWorldPosition(this.cam);
      if (!this.prev) { this.prev = this.cam.clone(); return; }

      var dx = this.cam.x - this.prev.x, dz = this.cam.z - this.prev.z;
      var mov = Math.sqrt(dx * dx + dz * dz);
      if (mov > this.data.salto) { this.revisar = true; this.prev.copy(this.cam); return; }
      if (mov < 1e-5 || !this.mallas.length) { this.prev.copy(this.cam); return; }

      var r = this.libre(this.prev, this.cam);
      if (r) {
        // Deslizar: quitar la parte del movimiento que va contra la pared
        var n = r.choque.normal; n.y = 0;
        var destino = this.prev.clone();
        if (n.lengthSq() > 1e-6) {
          n.normalize();
          var dv = new THREE.Vector3(dx, 0, dz);
          if (n.dot(dv) > 0) n.negate();                // normal mirando hacia el visitante
          dv.addScaledVector(n, -dv.dot(n));            // componente paralela a la pared
          var intento = this.prev.clone().add(dv);
          if (dv.lengthSq() > 1e-8 && !this.libre(this.prev, intento)) destino = intento;
        }
        // mover el rig lo necesario para dejar la cámara en "destino"
        var p = this.el.object3D.position;
        p.x += destino.x - this.cam.x;
        p.z += destino.z - this.cam.z;
        this.cam.x = destino.x; this.cam.z = destino.z;
      }
      this.prev.copy(this.cam);
    }
  });
})();
