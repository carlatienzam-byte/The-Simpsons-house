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
   · Los cielos enormes y los personajes ANIMADOS se ignoran solos. Los
     modelos con esqueleto que no se mueven (p. ej. la puerta torii) sí
     chocan: su forma se "congela" al cargar.
   · TECHO (opcional, colision-malla="techo: true"): al subir con ▲ el
     visitante se detiene bajo cualquier superficie: techos, bóvedas, arcos.
   · SUELO: al bajar (botón ▼ o agachándose con las gafas) el visitante
     se detiene a "sobreSuelo" metros de cualquier superficie horizontal:
     suelos de los GLB y planos de A-Frame (a-plane, a-box o a-cylinder
     planos). Esos planos solo frenan en vertical, nunca hacen de pared.
   ════════════════════════════════════════════════════════════════════ */
(function () {
  if (!window.AFRAME || !window.THREE) return;
  var BVH = window.MeshBVHLib && window.MeshBVHLib.MeshBVH;

  AFRAME.registerComponent('colision-malla', {
    schema: {
      radio:   {default: 0.3},        // distancia mínima a la pared (m)
      // alturas de comprobación, en metros por DEBAJO de los ojos: cada 25 cm, de la cabeza
      // a casi el suelo, para que ni un panel estrecho (vallas) se cuele entre dos rayos
      alturas: {default: '0.05 0.3 0.55 0.8 1.05 1.3'},
      salto:   {default: 3},          // movimientos mayores (teletransportes) no se comprueban
      pendiente: {default: 0.7},      // superficies más tumbadas que ~45° (suelo, terreno) no bloquean
      maximo:  {default: 150},        // mallas más grandes: solo cuentan como suelo
      sobreSuelo: {default: 0.4},     // altura mínima de los ojos sobre el suelo (m)
      techo:   {default: false},      // true: al subir (▲) tampoco se atraviesan techos, bóvedas ni arcos
      bajoTecho: {default: 0.25}      // distancia mínima de los ojos al techo (m)
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
      this._caja = new THREE.Box3(); this._tam = new THREE.Vector3();

      if (!BVH) { console.warn('[colisiones] Falta three-mesh-bvh: colisiones desactivadas'); return; }

      var self = this;
      this.alCargar = function (e) { self.registrar(e.target); };
      this.el.sceneEl.addEventListener('model-loaded', this.alCargar);
      // modelos que ya hubieran cargado antes que este componente
      this.el.sceneEl.querySelectorAll('[gltf-model]').forEach(function (el) { self.registrar(el); });
      // planos de suelo hechos con primitivas de A-Frame
      this.buscarSuelos = function () { self.registrarPrimitivas(); };
      if (this.el.sceneEl.hasLoaded) setTimeout(this.buscarSuelos, 0);
      else this.el.sceneEl.addEventListener('loaded', this.buscarSuelos);
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

    /* ¿El modelo (o algún antepasado) tiene animación? */
    animado: function (el) {
      for (var e = el; e && e !== this.el.sceneEl; e = e.parentEl) {
        if (e.hasAttribute && e.hasAttribute('animation-mixer')) return true;
      }
      return false;
    },

    /* Forma "congelada" de un modelo con esqueleto: posiciones ya deformadas por los huesos */
    congelar: function (m) {
      if (m.skeleton) m.skeleton.update();
      var src = m.geometry, n = src.attributes.position.count, v = new THREE.Vector3();
      var pos = new Float32Array(n * 3);
      for (var i = 0; i < n; i++) { m.getVertexPosition(i, v); pos[3 * i] = v.x; pos[3 * i + 1] = v.y; pos[3 * i + 2] = v.z; }
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      if (src.index) g.setIndex(src.index.clone());
      g.computeBoundingSphere(); g.computeBoundingBox();
      return g;
    },

    registrar: function (el) {
      if (!el || !el.getObject3D) return;
      var raiz = el.getObject3D('mesh');
      if (!raiz || this.vistos.has(raiz) || this.excluido(el)) return;
      this.vistos.add(raiz);
      var self = this, animado = this.animado(el);
      raiz.traverse(function (o) {
        if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
        if (o.isSkinnedMesh && animado) return;      // personaje animado: su forma cambia, no se usa
        self.cola.push(o);
      });
    },

    /* Primitivas planas y grandes (a-plane, a-box, a-cylinder…) → solo suelo */
    registrarPrimitivas: function () {
      var self = this, caja = new THREE.Box3(), tam = new THREE.Vector3();
      this.el.sceneEl.querySelectorAll('[geometry]').forEach(function (el) {
        if (self.excluido(el)) return;
        var m = el.getObject3D('mesh');
        if (!m || !m.isMesh || self.vistos.has(m) || !m.geometry || !m.geometry.attributes.position) return;
        var g = m.geometry;
        if (!g.boundingBox) g.computeBoundingBox();
        m.updateWorldMatrix(true, false);
        caja.copy(g.boundingBox).applyMatrix4(m.matrixWorld).getSize(tam);
        var ancho = Math.max(tam.x, tam.z);
        if (ancho < 2 || tam.y > ancho * 0.3) return;      // no es un suelo
        self.vistos.add(m);
        m.userData.soloSuelo = true;
        self.cola.push(m);
      });
    },

    /* Prepara (BVH) unas pocas mallas por fotograma */
    preparar: function () {
      var inicio = performance.now();
      if (this.cola.length) this.revisar = true;
      while (this.cola.length && performance.now() - inicio < 8) {
        var m = this.cola.shift(), g = m.geometry;
        try {
          if (m.isSkinnedMesh) { m.updateWorldMatrix(true, false); g = this.congelar(m); }
          if (!g.boundingSphere) g.computeBoundingSphere();
          if (!g.boundingBox) g.computeBoundingBox();
          m.updateWorldMatrix(true, false);
          // Tamaño REAL en el mundo, a partir de la caja. (Con los modelos de
          // gltfpack la escala no es igual en los tres ejes y la esfera
          // envolvente exageraba el tamaño: una tienda de 15 m salía de 199 m.)
          var radioMundo = this._caja.copy(g.boundingBox).applyMatrix4(m.matrixWorld).getSize(this._tam).length() / 2;
          if (g.morphAttributes && g.morphAttributes.position && g.morphAttributes.position.length) continue;
          // cielos, montañas lejanas y planos: solo cuentan como suelo
          var soloSuelo = !!m.userData.soloSuelo || radioMundo > this.data.maximo;
          if (!g.boundsTree) g.boundsTree = new BVH(g, {maxLeafTris: 12});
          var geo = (g !== m.geometry) ? g : null;     // geometría congelada (modelos con esqueleto)
          if (m.isInstancedMesh) {
            for (var i = 0; i < m.count; i++) this.mallas.push({mesh: m, inst: i, soloSuelo: soloSuelo, geo: geo});
          } else {
            this.mallas.push({mesh: m, inst: -1, soloSuelo: soloSuelo, geo: geo});
          }
        } catch (err) { /* geometría rara: se ignora */ }
      }
    },

    camara: function () {
      if (this.el.components && this.el.components.camera) return this.el;
      return this.el.querySelector('[camera]');
    },

    visible: function (o) {
      for (; o; o = o.parent) if (o.visible === false) return false;
      return true;
    },

    /* Rayo: devuelve {dist, normal, item} del primer choque o null.
       suelo=false → solo paredes (superficies empinadas)
       suelo=true  → solo suelos (superficies tumbadas), incluidos los planos
       suelo='todo'→ cualquier superficie (para los techos) */
    lanzar: function (origen, dir, lejos, suelo) {
      if (suelo === undefined) suelo = false;
      var mejor = null, mejorD = lejos;
      for (var k = 0; k < this.mallas.length; k++) {
        var it = this.mallas[k], m = it.mesh, g = it.geo || m.geometry;
        if (it.ignorar) continue;
        if (it.soloSuelo && suelo === false) continue;
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
          if (suelo === true && Math.abs(nrm.y) <= this.data.pendiente) continue;
          if (suelo === false && Math.abs(nrm.y) > this.data.pendiente) continue;
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
        var c = new THREE.Vector3(), camEl = this.camara() || this.el;
        camEl.object3D.getWorldPosition(c);
        this.liberar(c);
      }
      this.resolver();
    },
    tock: function () { this.resolver(); },

    resolver: function () {
      if (!BVH) return;
      var camEl = this.camara();
      if (!camEl) return;
      camEl.object3D.getWorldPosition(this.cam);
      if (!this.prev) { this.prev = this.cam.clone(); return; }

      // ── SUELO: si se ha bajado, comprobar que no se atraviesa ninguna superficie
      var dy = this.cam.y - this.prev.y;
      if (dy < -1e-5 && dy > -this.data.salto && this.mallas.length) {
        this._o.set(this.cam.x, this.prev.y, this.cam.z);
        var abajo = this.lanzar(this._o, new THREE.Vector3(0, -1, 0), -dy + this.data.sobreSuelo, true);
        if (abajo) {
          var minimo = Math.min(this.prev.y, this.prev.y - abajo.dist + this.data.sobreSuelo);
          if (this.cam.y < minimo) {
            camEl.object3D.position.y += minimo - this.cam.y;   // la cámara es la que sube/baja
            this.cam.y = minimo;
          }
        }
      }

      // ── TECHO: si se ha subido, comprobar que no se atraviesa nada por arriba
      if (this.data.techo && dy > 1e-5 && dy < this.data.salto && this.mallas.length) {
        this._o.set(this.cam.x, this.prev.y, this.cam.z);
        var arriba = this.lanzar(this._o, new THREE.Vector3(0, 1, 0), dy + this.data.bajoTecho, 'todo');
        if (arriba) {
          var maximo = Math.max(this.prev.y, this.prev.y + arriba.dist - this.data.bajoTecho);
          if (this.cam.y > maximo) {
            camEl.object3D.position.y -= this.cam.y - maximo;
            this.cam.y = maximo;
          }
        }
      }

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
