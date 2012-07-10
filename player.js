// Copyright 2011-2012 Kevin Reid under the terms of the MIT License as detailed
// in the accompanying file README.md or <http://opensource.org/licenses/MIT>.

(function () {
  "use strict";
  
  var AAB = cubes.util.AAB;
  var Blockset = cubes.Blockset;
  var Body = cubes.Body;
  var CubeRotation = cubes.util.CubeRotation;
  var dynamicText = cubes.util.dynamicText;
  var exponentialStep = cubes.util.exponentialStep;
  var mkelement = cubes.util.mkelement;
  var mod = cubes.util.mod;
  var Notifier = cubes.util.Notifier;
  var Selection = cubes.Selection;
  var World = cubes.World;
  var WorldRenderer = cubes.WorldRenderer;
  var ZEROVEC = cubes.util.ZEROVEC;
  
  function noop() {}
  
  // physics constants
  var WALKING_SPEED = 4; // cubes/s
  var FLYING_SPEED = 10; // cubes/s
  var GRAVITY = 20; // cubes/s^2
  var JUMP_SPEED = 8; // cubes/s
  var MAX_STEP_UP = 0.57; // cubes
  var CONTROL_STIFFNESS = 0.18;
  var AIRSTEER_STIFFNESS = 0.03;
  
  var playerAABB = new AAB(
    -0.35, 0.35, // x
    -1.75, 0.15, // y
    -0.35, 0.35 // z
  );

  function Player(config, initialWorld, renderer, audio, scheduleDraw, objectUI) {
    var player = this;
    var gl = renderer.context;
    
    // a Place stores a world and state in it; used for push/pop
    function Place(world, bodyInitializer) {
      this.world = world;
      this.cursor = null;
      this.tool = 2; // first non-bogus block id

      this.selection = new Selection(world);
      this.selection.setToAAB(new AAB(5, 10, 5, 10, 5, 10));
      
      // find or make body
      var body = world.playerBody;
      if (body) {
        this.bodyIsWorldly = true;
        //console.log("Found existing body at " + vec3.str(body.pos));
      } else {
        body = new Body(world, playerAABB);
        Object.defineProperty(body, "noclip", { enumerable: true, get: function () { // TODO kludge
          return config.noclip.get();
        }});
        bodyInitializer(body);
        //console.log("Created unworldly body with " + vec3.str(body.pos));
        this.bodyIsWorldly = false;
      }
      this.body = body;

      // must happen late
      this.wrend = new WorldRenderer(world, function () { return body.pos; }, renderer, audio, scheduleDraw, true);
    }
    Place.prototype.delete = function () {
      this.wrend.deleteResources();
    };

    // Worlds we've been in
    var placeStack = [];
    var currentPlace;

    // kludge: Since UI sets pitch absolutely, it's not a place variable
    var pitch = 0;
    
    var exposure = 1.0;
    
    var movement = vec3.create();
    var mousePos = null; // or an [screen x, screen y] vector. Immutable value.
  
    var cursorR = new renderer.RenderBundle(gl.LINE_LOOP, null, function (vertices, normals, colors) {
      var sel = currentPlace ? currentPlace.cursor : null;
      if (sel !== null) {
        var p = vec3.create(sel.cube);

        // This works, but don't ask me to justify it. We're taking the face normal vector and deriving a selection box.
        var qp = vec3.subtract(vec3.create(), sel.face);
        var qr = [-qp[1], -qp[2], -qp[0]]; // first perpendicular vector 
        var qs = vec3.cross(qp, qr, vec3.create()); // second perpendicular vector
        
        if (qp[0]+qp[1]+qp[2] > 0) {
          vec3.subtract(p, qr);
        } else {
          vec3.subtract(p, qp);
        }
        
        colors.push(1,1,1,1); normals.push(0,0,0); vertices.push(p[0],p[1],p[2]);
        colors.push(1,1,1,1); normals.push(0,0,0); vertices.push(p[0]+qr[0],p[1]+qr[1],p[2]+qr[2]);
        colors.push(1,1,1,1); normals.push(0,0,0); vertices.push(p[0]+qr[0]+qs[0],p[1]+qr[1]+qs[1],p[2]+qr[2]+qs[2]);
        colors.push(1,1,1,1); normals.push(0,0,0); vertices.push(p[0]+qs[0],p[1]+qs[1],p[2]+qs[2]);
      }
    }, {
      aroundDraw: function (draw) {
        renderer.setLineWidth(1);
        gl.disable(gl.DEPTH_TEST);
        draw();
        gl.enable(gl.DEPTH_TEST);
      }
    });
    
    var aabbR = renderer.aabRenderer(function (draw) {
      if (currentPlace) {
        draw(currentPlace.body.pos, playerAABB, [0,0,1]);
        currentPlace.body.debugHitAABBs.forEach(function (aabb) {
          draw(ZEROVEC, aabb, [0,1,0]);
        });
      }
    });
    
    function _transformPointToSubworld(cube,world,rot,point) {
      var buf = vec3.create(point);
      vec3.subtract(buf, cube);
      rot.transformPoint(buf, buf);
      vec3.scale(buf, world.wx); // cubical assumption
      return buf;
    }
    
    function aimChanged() {
      scheduleDraw(); // because this routine is also 'view direction changed'

      var foundCube = null, foundFace = null;
      if (mousePos !== null) {
        var w = currentPlace.world;
        var ray = renderer.getAimRay(mousePos, player.render);
        w.raycast(ray.origin, ray.direction, 20, function (x,y,z,value,face) {
          if (w.selectable(x,y,z)) {
            var cube = Object.freeze([x,y,z]);
            var type = w.blockset.get(value);
            var subfound = false;
            if (!type.opaque && type.world) {
              // test against shape of noncubical block
              var w1 = type.world;
              var rot = CubeRotation.byCode[w.gRot(x,y,z)].inverse;
              w1.raycast(_transformPointToSubworld(cube,w1,rot,ray.origin),
                         rot.transformVector(ray.direction),
                         Infinity,
                         function (x1,y1,z1,v1,f1) {
                if (w1.selectable(x1,y1,z1)) {
                  subfound = true;
                  return true;
                }
              });
              if (!subfound) return;
            }
            foundCube = cube;
            foundFace = Object.freeze(Array.prototype.slice.call(face));
            return true;
          }
        });
        // Note: If we ever want to enable selection of the edges of the world,
        // then that can be done by noting the last cube the raycast hit.
      }
      
      var newSel;
      if (foundCube !== null) {
        newSel = Object.freeze({
          cube: foundCube,
          face: foundFace,
          toString: function () { return this.cube + ";" + this.face; }
        });
      } else {
        newSel = null;
      }
      
      if (String(currentPlace.cursor) !== String(newSel)) {
        currentPlace.cursor = newSel;
        cursorR.recompute();
        scheduleDraw();
      }
    }
    
    function updateAudioListener() {
      audio.setListener.apply(audio, currentPlace.body.getListenerParameters());
    }
    
    function computeExposure() {
      var world = currentPlace.world;

      // TODO inefficient to rebuild this matrix — cache! This is the inverse of applyViewRot
      var matrix = mat4.identity();
      mat4.rotate(matrix, currentPlace.body.yaw, [0, 1, 0]);
      mat4.rotate(matrix, pitch, [1, 0, 0]);
      
      var pos = currentPlace.body.pos;
      var light = 0;
      var hits = 0;
      function ray(look /* overwritten */) {
        mat4.multiplyVec3(matrix, look);
        var foundOpenSpace = false;
        world.raycast(pos, look, 20/*TODO magic number */, function (x,y,z,value,face) {
          if (world.opaque(x,y,z)) { // TODO use appropriate test; what we actually want here is "is this a block which has a valid light value
            if (foundOpenSpace) {
              x += face[0];
              y += face[1];
              z += face[2];
              light += world.gLight(x,y,z);
              hits++;
              return true;
            }
          } else {
            // This flag keeps the ray from stopping immediately if we are inside opaque blocks.
            foundOpenSpace = true;
          }
        });
      }
      for (var x = -1; x <= 1; x++)
      for (var y = -1; y <= 1; y++) {
        ray([x/2, y/2, -1]);
      }
      
      var localLightFactor = (hits ? light / hits : world.lightOutside) * world.lightScale;
      var compensation = 0.75;
      
      return 1/(((localLightFactor - 1) * compensation) + 1);
    }
    
    this.getExposure = function () {
      return exposure;
    };
    
    var footstepPhase = 0;
    var footstepPeriod = 1.4;
    var footstepY = 0;
    
    var EPSILON = 1e-3;
    function stepPlayer(timestep) {
      var body = currentPlace.body;
      var floor = body.getFloor();
      
      // determine coordinate system for movement control
      var controlOrientation = mat4.identity(mat4.create());
      mat4.rotateY(controlOrientation, body.yaw);
      if (body.flying && config.pitchRelativeFlight.get() /* && is mouselook mode? */) {
        mat4.rotateX(controlOrientation, pitch);
      }
      
      // apply movement control to velocity
      var movAdj = vec3.create();
      mat4.multiplyVec3(controlOrientation, movement, movAdj);
      vec3.scale(movAdj, body.flying ? FLYING_SPEED : WALKING_SPEED);
      
      var stiffness = !body.flying && !floor ? AIRSTEER_STIFFNESS : CONTROL_STIFFNESS;
      
      body.addVelocity([
        (movAdj[0] - body.vel[0]) * stiffness,
        body.flying ? (movAdj[1] - body.vel[1]) * stiffness
        : movAdj[1] !== 0 ? (movAdj[1] - body.vel[1]) * stiffness + timestep * GRAVITY : 0,
        (movAdj[2] - body.vel[2]) * stiffness]);

      if (config.lighting.get()) {
        var newExposure = computeExposure();
        if (newExposure !== exposure && !isNaN(newExposure)) {
          exposure = exponentialStep(exposure, newExposure, timestep, -0.7, 1e-3);
          if (isNaN(exposure)) {
            exposure = 1.0;
          }
          scheduleDraw();
        }
      }
    }
    
    function afterPlayerBodyMoved(beforeMoveVel, timestep) {
      var body = currentPlace.body;
      
      updateAudioListener();
      aimChanged();

      var floor = body.getFloor();
      if (vec3.length(movement) < EPSILON) {
        footstepPhase = 0;
      } else {
        footstepPhase += vec3.length(body.vel) * timestep;
      }
      if (footstepPhase > footstepPeriod) {
        footstepPhase = mod(footstepPhase, footstepPeriod);
        playFootstep();
      } else if (floor && beforeMoveVel[1] < -1 || body.pos[1] > footstepY && footstepPhase > 0.4) {
        // footstep sooner if just hit a bump or fell down
        footstepPhase = 0;
        playFootstep();
      }
      function playFootstep() {
        footstepY = body.pos[1];
        // TODO play sounds for all blocks below or otherwise be less biased (getFloor gives arbitrary results)
        var type = floor && body.world.gtv(floor);
        if (type) {
          audio.play(floor, type, "footstep", 0.5);
        }
      }
    }
    
    this.stepYourselfAndWorld = function (timestep) {
      var body = currentPlace.body;
      stepPlayer(timestep);

      var beforeMovePos = vec3.set(body.pos, new Float64Array(3));
      var beforeMoveVel = vec3.set(body.vel, new Float64Array(3));
      currentPlace.world.step(timestep);
      if (!currentPlace.bodyIsWorldly) body.step(timestep, noop);
      if (vec3.dist(beforeMovePos, body.pos) > 0) {
        afterPlayerBodyMoved(beforeMoveVel, timestep);
      }
      
      currentPlace.world.polishLightInVicinity(currentPlace.body.pos, config.renderDistance.get(), 1);
      if (config.debugPlayerCollision.get()) {
        aabbR.recompute();
        scheduleDraw();
      }
    };
    
    // --- The facet for rendering ---
    
    var worldSceneObject = {
      draw: function () { 
        currentPlace.wrend.draw();
        if (config.debugPlayerCollision.get()) aabbR.draw();
      }
    };
    
    var cursorInfoTextElem = document.createElement("pre");
    var cursorInfoElem = mkelement("div", "overlay");
    cursorInfoElem.appendChild(cursorInfoTextElem);
    var cursorInfo = dynamicText(cursorInfoTextElem);
    var cursorSceneObject = {
      draw: function () {
        cursorR.draw();
        
        // Update HTML part
        cursorInfo.data = "";
        var cur = player.getCursor();
        if (cur !== null) {
          var cube = cur.cube;
          var empty = vec3.add(cur.cube, cur.face, vec3.create());
          
          var world = player.getWorld();
          var value = world.gv(cube);
          var sub = world.gSubv(cube);
          var type = world.gtv(cube);
          var light = type.opaque ? world.gLightv(empty)
                                  : world.gLightv(cube);
          var text = (
            value
            + (sub ? ":" + sub : "")
            + (type.name ? " (" + type.name + ")" : "")
            + "\nat " + cur.cube
            + "\n" + (type.opaque ? "Surface" : "Interior") + " light: " + light
          );
          
          var circuit = world.getCircuit(cube);
          if (circuit !== null) {
            text += "\nCircuit: " + type.behavior.name + " " + circuit.describeBlock(cube);
          }
          cursorInfo.data = text;
        }
      },
      element: cursorInfoElem,
      boundsPoints: function (considerPoint) {
        var cur = player.getCursor();
        if (cur !== null) {
          var cube = cur.cube;
          for (var dx = 0; dx <= 1; dx++)
          for (var dy = 0; dy <= 1; dy++)
          for (var dz = 0; dz <= 1; dz++) {
            considerPoint(cube[0] + dx, cube[1] + dy, cube[2] + dz, 1);
          }
        }
      }
    };
    
    var selectionSceneObject = null;
    
    function rebuildSelectionObj() {
      var selection = currentPlace.selection;
      
      if (selectionSceneObject && selectionSceneObject._getTheSelection() == selection) return;
      
      if (selectionSceneObject) selectionSceneObject.deleteResources();
      
      if (selection !== null) {
        var selectionR = renderer.aabRenderer(function (draw) {
          draw(ZEROVEC, selection.bounds, [0,1,1]);
        });
        
        var chip = new objectUI.ObjectChip();
        chip.bindByObject(selection);
        
        selectionSceneObject = {
          draw: function () {
            selectionR.draw();
          },
          element: mkelement("div", "overlay", chip.element),
          boundsPoints: function (considerPoint) {
            var bounds = selection.bounds;
            for (var dx = 0; dx <= 1; dx++)
            for (var dy = 0; dy <= 1; dy++)
            for (var dz = 0; dz <= 1; dz++) {
              considerPoint(bounds[0 + dx], bounds[2 + dy], bounds[4 + dz], 1);
            }
          },
          deleteResources: function () { // not part of scene object protocol
            selectionR.deleteResources();
          },
          _getTheSelection: function () { // not part of scene object protocol
            return selection;
          }
        };
      } else {
        selectionSceneObject = null;
      }
    }
    
    this.render = Object.freeze({
      applyViewRot: function (matrix) {
        mat4.rotate(matrix, -pitch, [1, 0, 0]);
        mat4.rotate(matrix, -currentPlace.body.yaw, [0, 1, 0]);
      },
      applyViewTranslation: function (matrix) {
        var positionTrans = vec3.negate(currentPlace.body.pos, vec3.create());
        positionTrans[1] += currentPlace.body.cameraYLag;
        currentPlace.body.cameraYLag *= 0.75; /*Math.exp(-timestep*10) TODO we should be like this */
        mat4.translate(matrix, positionTrans);
      },
      getPosition: function() {
        return vec3.create(currentPlace.body.pos);
      },
      forEachSceneObject: function (callback) {
        callback(worldSceneObject);
        callback(cursorSceneObject);
        if (selectionSceneObject) callback(selectionSceneObject);
      },
      getWorldRenderer: function () {
        return currentPlace.wrend;
      }
    });
    this.setPosition = function(p) {
      vec3.set(p, currentPlace.body.pos);
      updateAudioListener();
    };
    this.getWorld = function() {
      return currentPlace.world;
    };
    this.getBody = function() {
      return currentPlace.body;
    };
    this.getCursor = function() {
      return currentPlace.cursor;
    };
    this.setWorld = function (world) {
      if (currentPlace) currentPlace.delete();
      while (placeStack.length) placeStack.pop().delete();
      currentPlace = new Place(world, function (body) {
        // TODO: move this position downward to free space rather than just imparting velocity
        body.pos[0] = world.wx/2;
        body.pos[1] = world.wy - playerAABB.get(1, 0) + EPSILON;
        body.pos[2] = world.wz/2;
        body.vel[1] = -120;
      });
      notifyChangedPlace();
    };
    
    // --- The facet for user input ---
    
    var inputNotifier = new Notifier("player.input");
    this.input = Object.freeze({
      listen: inputNotifier.listen,
      
      useTool: function () {
        if (currentPlace.tool === Blockset.ID_EMPTY) {
          this.deleteBlock();
        } else {
          // create block
          if (currentPlace.cursor !== null) {
            var cube = currentPlace.cursor.cube;
            var face = currentPlace.cursor.face;
            var x = cube[0]+face[0], y = cube[1]+face[1], z = cube[2]+face[2];
            var type = currentPlace.world.blockset.get(currentPlace.tool);
            if (currentPlace.world.g(x,y,z) === 0) {
              // TODO: rotation on create should be more programmable.
              var ray = renderer.getAimRay(mousePos, player.render); // TODO depend on player orientation instead?
              var rotation = CubeRotation.nearestToDirection(
                  vec3.negate(ray.direction, vec3.create()),
                  [0,0,1],
                  type.automaticRotations.map(
                      function (code) { return CubeRotation.byCode[code]; }));
              currentPlace.world.s(x,y,z, currentPlace.tool, rotation.code);
              
              currentPlace.wrend.renderCreateBlock([x,y,z]);
              currentPlace.world.audioEvent([x,y,z], "create");
              aimChanged();
            }
          }
        }
      },
      deleteBlock: function () {
        if (currentPlace.cursor !== null) {
          var cube = currentPlace.cursor.cube;
          var x = cube[0], y = cube[1], z = cube[2];
          if (currentPlace.world.g(x,y,z) !== 0 /* i.e. would destruction do anything */) { 
            var value = currentPlace.world.g(x,y,z);
            currentPlace.wrend.renderDestroyBlock(cube);
            currentPlace.world.audioEvent(cube, "destroy");
            currentPlace.world.s(x, y, z, 0);
            aimChanged();
          }
        }
      },
      tweakSubdata: function (delta) {
        if (currentPlace.cursor !== null) {
          var cube = currentPlace.cursor.cube;
          var x = cube[0], y = cube[1], z = cube[2];
          currentPlace.world.sSub(x, y, z,
              mod(currentPlace.world.gSub(x,y,z) + delta, World.subdatumBound));
        }
      },
      get blockset () { return currentPlace.world.blockset; },
      set blockset (value) { throw new TypeError("player.input.blockset read-only"); },
      get movement () { throw new TypeError("player.input.movement write-only"); },
      set movement (value) { 
        vec3.set(value, movement);
        if (movement[1] > 0) {
          currentPlace.body.flying = true;
        }
      },
      get mousePos () { throw new TypeError("player.input.mousePos write-only"); },
      set mousePos (value) { mousePos = value; aimChanged(); },
      get pitch () { return pitch; },
      set pitch (value) { pitch = value; aimChanged(); },
      get yaw () { return currentPlace.body.yaw; },
      set yaw (value) { currentPlace.body.yaw = value; aimChanged(); },
      get tool () { return currentPlace.tool; },
      set tool (value) { 
        currentPlace.tool = value; 
        inputNotifier.notify("changedTool");
      },
      enterWorld: function (blockID) {
        var world = currentPlace.world.blockset.get(blockID).world;

        if (!world) { return; } // TODO: UI message about this

        var oldPlace = currentPlace;

        currentPlace = new Place(world, function (body) {
          body.pos[0] = world.wx/2;
          body.pos[1] = world.wy - playerAABB.get(1, 0) + EPSILON;
          body.pos[2] = world.wz/2;
        });
        currentPlace.forBlock = blockID;
        placeStack.push(oldPlace);

        notifyChangedPlace();
      }, 
      changeWorld: function (direction) {
        switch (direction) {
          case 1:
            if (currentPlace.cursor === null) return;
            var cube = currentPlace.cursor.cube;
            var x = cube[0], y = cube[1], z = cube[2];
            
            var oldPlace = currentPlace;
            var blockID = currentPlace.world.g(x,y,z);
            
            var world = currentPlace.world.blockset.worldFor(blockID);
            if (!world) return; // TODO: UI message about this
            var tileSize = world.wx;
            
            currentPlace = new Place(world, function (body) {
              // Initial adjustments:
              // Make new position same relative to cube
              vec3.subtract(oldPlace.body.pos, cube, body.pos);
              vec3.scale(body.pos, tileSize);
              // ... but not uselessly far away.
              vec3.scale(body.pos, Math.min(1.0, (tileSize+40)/vec3.length(body.pos))); // TODO make relative to center of world, not origin
              // Same velocity, scaled
              vec3.set(oldPlace.body.vel, body.vel);
              vec3.scale(body.vel, tileSize);
              // Same view direction
              body.yaw = oldPlace.body.yaw;
              // And not falling.
              body.flying = true;
            });
            
            // This is needed because the routine in aimChanged assumes currentPlace knows the old state of the cursor. TODO: Kludgy.
            cursorR.recompute();
            
            placeStack.push(oldPlace);
            
            break;
          case -1:
            if (placeStack.length <= 0) return;
            currentPlace.delete();
            currentPlace = placeStack.pop();
            break;
        }
        
        notifyChangedPlace();
      },
      jump: function () {
        currentPlace.body.jump([0, JUMP_SPEED, 0]);
      }
    });
    
    function notifyChangedPlace() {
      aimChanged();
      aabbR.recompute();
      updateAudioListener();
      
      rebuildSelectionObj();
      
      inputNotifier.notify("changedWorld");
    }
    
    // --- Initialization ---
    
    config.debugPlayerCollision.listen({
      interest: function () { return true; },
      changed: scheduleDraw
    });
    
    this.setWorld(initialWorld);
  }
  
  Player.aabb = playerAABB;
  
  cubes.Player = Object.freeze(Player);
}());
