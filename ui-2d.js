// Copyright 2012 Kevin Reid under the terms of the MIT License as detailed
// in the accompanying file README.md or <http://opensource.org/licenses/MIT>.

(function () {
  "use strict";
  
  var Blockset = cubes.Blockset;
  var BlockType = cubes.BlockType;
  var Circuit = cubes.Circuit;
  var cyclicSerialize = cubes.storage.cyclicSerialize;
  var mkelement = cubes.util.mkelement;
  var Persister = cubes.storage.Persister;
  var World = cubes.World;
  var WorldGen = cubes.WorldGen;
  
  function ObjectUI(persistencePool) {
    var ui = this;
    
    var normalFocusElement;
    
    // --- Object chips ---
    
    function ObjectChip() {
      var bound = false;
      var menuE;
      var target = null, targetName = null;
      
      // Construct DOM
      var nameE = mkelement("span");
      var menuButtonE = mkelement("button", "", "▾");
      menuButtonE.addEventListener("mousedown", openMenu, false);
      menuButtonE.addEventListener("click", openMenu, false);
      var chipE = mkelement("span", "presentation object-chip", nameE, menuButtonE);
      chipE.style.position = "relative";
      
      this.bindByName = function (name) {
        if (bound) throw new Error("ObjectChip already bound");
        bound = true;
        targetName = name;
        updateChip();
      };
      this.bindByObject = function (object) {
        if (bound) throw new Error("ObjectChip already bound");
        bound = true;
        target = object;
        updateChip();
      };
      
      function getChipTarget() {
        if (target !== null) {
          return target;
        } else {
          return persistencePool.get(targetName);
        }
      }
      
      function updateChip() {
        if (target !== null && targetName !== null) {
          throw new Error("Inconsistent");
          
        } else if (target !== null) {
          // Examine object
          var label = null;
          if (target.persistence) {
            label = persistencePool.getObjectName(target);
            chipE.classList.add("object-chip-live");
          }
          if (label === null) {
            label = "a ";
            
            if (target instanceof World) {
              label += target.wx + "×" + target.wy + "×" + target.wz + " ";
            }
            label += Persister.findType(target.constructor);
            if (target instanceof BlockType && target.name !== null) {
              label += " “" + target.name + "”";
            }
            
            chipE.classList.add("object-chip-ephemeral");
          }
          
          nameE.textContent = label;
          
        } else if (targetName !== null) {
          nameE.textContent = targetName;
          chipE.classList.add(persistencePool.getIfLive(targetName) ? "object-chip-live" : "object-chip-named");

        } else {
          throw new Error("Can't happen");
        }
      }
      
      function openMenu(event) {
        event.stopPropagation();
        
        updateChip();
        
        if (menuE) {
          return;
        }
        
        var menuListE;
        menuE = mkelement("div", "command-menu",
          menuListE = mkelement("ul")
        );
        menuE.tabIndex = 0; // make focusable
        menuE.style.position = "absolute";
        menuE.style.zIndex = "1";
        menuE.style.right = (0) + "px";
        menuE.style.top = (menuButtonE.offsetTop + menuButtonE.offsetHeight) + "px";
        
        function addControl(label, fn) {
          var b;
          menuListE.appendChild(mkelement("li", "",
            b = mkelement("button", "", label)
          ));
          b.addEventListener("click", function (e) {
            e.stopPropagation();
            dismiss();
            fn();
            updateChip(); // TODO kludge; updates should be based on notifications
            return true;
          }, false);
        }
        
        if (targetName !== null) {
          addControl("Delete", function () {
            if (window.confirm("Really delete “" + targetName + "”?")) {
              persistencePool.ephemeralize(targetName);
            }
          });
          
          // TODO add rename
        }
        
        if (targetName === null && target !== null) {
          addControl("Save As...", function () {
            var response = window.prompt("Save " + nameE.textContent + " as:", nameE.textContent);
            if (response !== null) {
              persistencePool.persist(target, response);
            }
          });
        }
        
        addControl("Inspect", function () {
          ui.inspect(getChipTarget());
        });
        
        addControl("Export", function () {
          var panel = ui.openNewPanel();

          var expchip = new ObjectChip();
          expchip.bindByObject(getChipTarget());
          panel.appendChild(mkelement("h2", "", "Export of ", expchip.element));
          
          var data = mkelement("textarea");
          data.cols = 20;
          data.rows = 20;
          data.readonly = true;
          // TODO add class for style hooking
          panel.appendChild(data);
          
          try {
            data.value = JSON.stringify(cyclicSerialize(getChipTarget(), Persister.findType));
          } catch (e) {
            data.value = "Error: " + e;
          }
        });
        
        chipE.appendChild(menuE);
        var el;
        menuE.addEventListener("blur", el = function () {
          setTimeout(dismiss, 0); // undeferred blur effects have caused trouble
        }, false);
        menuE.focus();
        
        function dismiss() {
          if (!menuE) return;
          menuE.parentElement.removeChild(menuE);
          menuE.removeEventListener("blur", el);
          menuE = undefined;
        }
      }
      
      
      // Final initialization
      
      this.element = chipE;
      
      Object.freeze(this);
    }
    this.ObjectChip = ObjectChip;
    
    // --- Panel manager ---
    
    this.refocus = function () {
      if (normalFocusElement) normalFocusElement.focus();
    };
    
    var onymousPanels = Object.create(null);
    var currentlyOpenPanel = null;
    var currentlyOpenPanelName = null;
    
    function closePanel(element) {
      element.style.display = "none";
      if (currentlyOpenPanel === element) {
        if (currentlyOpenPanelName === null) {
          // anonymous panel is discarded
          element.parentElement.removeChild(element);
        }
        
        currentlyOpenPanel = null;
        currentlyOpenPanelName = null;
      }
    }
    
    function addPanelFeatures(element) {
      element.classList.add("sidebar"); // TODO make class name more generic
      element.addEventListener("click", function (event) {
        if (event.target.tagName == "INPUT" ||
            event.target.tagName == "LABEL" ||
            event.target.tagName == "BUTTON" ||
            event.target.tagName == "TEXTAREA") {
          return true;
        } else {
          closePanel(element);
          ui.refocus();
        }
      });
    }
    
    this.registerPanel = function (name, element) {
      onymousPanels[name] = element;
      
      element.style.display = "none";
      addPanelFeatures(element);
    };
    
    this.openPanel = function (name) {
      if (!(name in onymousPanels)) {
        throw new Error("unregistered panel");
      }
      var element = onymousPanels[name];
      
      if (currentlyOpenPanel) closePanel(currentlyOpenPanel);
      
      element.style.display = "block";
      currentlyOpenPanel = element;
      currentlyOpenPanelName = name;
    };
    
    this.openNewPanel = function () {
      var element = document.createElement("div");
      
      // TODO make tree position customizable
      document.body.appendChild(element);
      addPanelFeatures(element);
      
      if (currentlyOpenPanel) closePanel(currentlyOpenPanel);
      
      currentlyOpenPanel = element;
      currentlyOpenPanelName = null;
      
      return element;
    };
    
    this.setNormalFocusElement = function (v) {
      normalFocusElement = v;
    };
    
    // --- Inspector ---
    
    this.inspect = function (object) {
      var panel = this.openNewPanel();
      
      var titleChip = new this.ObjectChip();
      titleChip.bindByObject(object);
      
      panel.appendChild(mkelement("h2", "", "Inspecting ", titleChip.element));
      
      // TODO refactor this into something less hardcoded
      if (object instanceof World) {
        var blocksetChip = new this.ObjectChip();
        blocksetChip.bindByObject(object.blockset);
        
        panel.appendChild(mkelement("table", "",
          mkelement("tr", "",
            mkelement("th", "", "Blockset:"),
            mkelement("td", "", blocksetChip.element)
          ),
          mkelement("tr", "",
            mkelement("th", "", "Size:"),
            mkelement("td", "", String(object.wx), " × ", String(object.wy), " × ", String(object.wz))
          )
        ));
      } else if (object instanceof Blockset) (function () {
        // TODO listen to blockset
        // TODO strip out this code from input subsystem
        var blocksList = mkelement("ol");
        panel.appendChild(blocksList);
        var blocksetRender = renderer ? object.getRenderData(renderer) : null;
        function row(blockID) {
          var blockType = object.get(blockID);
          
          // TODO refactor so we can have an icon for a lone BlockType and make ObjectChip have an icon
          var icon = document.createElement("img");
          icon.style.verticalAlign = "middle"; // TODO stylesheet
          icon.style.width = icon.style.height = "1.2em";
          if (blocksetRender) {
            blocksetRender.icons[blockID].nowAndWhenChanged(function (url) {
              if (url !== null)
                icon.src = url;
              return true;
            });
          }
          
          var blockChip = new ObjectChip();
          blockChip.bindByObject(blockType);
          
          var item = mkelement("li", "", icon, blockChip.element);
          
          blocksList.appendChild(item);
        }
        for (var blockID = 1; blockID < object.length; blockID++) row(blockID);
        
        // TODO fold these buttons into a general command infrastructure.
        function addButton(label, action) {
          var button;
          panel.appendChild(mkelement("div", "", button = mkelement("button", "", label)));
          button.addEventListener("click", function () {
            try {
              action();
            } catch (e) {
              // TODO fold this into a general handling-errors-from-ui-actions infrastructure
              console.error("In button '" + label + "' event handler:", e);
              alert("Sorry, the operation failed unexpectedly.\n\n" + e);
            }
            return true;
          }, false);
        }
        // TODO these blockset-editing operations are assuming the sub-blockset to use is the blockset of the #1 block. We should either explicitly declare there is only one sub-blockset or provide a way to choose.
        addButton("New block type", function () {
          object.add(WorldGen.newRandomBlockType(object.tileSize, object.get(1).world.blockset));
        });
        addButton("Delete last block type", function () {
          object.deleteLast();
        });
        addButton("Add/update standard circuit blocks", function () {
          WorldGen.addLogicBlocks(object.tileSize, object, object.get(1).world.blockset);
        });
        
      }()); else if (object instanceof BlockType) (function () {
        var blockType = object;
        // TODO listen to block type for changes

        var rows;
        var table = mkelement("table", "",
          rows = mkelement("tbody", ""));
        panel.appendChild(table);

        function mkcell(title) {
          var cell;
          rows.appendChild(mkelement("tr", "",
            mkelement("th", "", title + ":"),
            cell = mkelement("td", "")));
          return cell;
        }

        // TODO include large icon/render

        // TODO: This code duplicates functionality of PersistentCell.bindControl — refactor so we can use that code here.

        var name = document.createElement("input");
        name.type = "text";
        name.value = blockType.name;
        name.onchange = function () {
          blockType.name = name.value;
          return true;
        };
        mkcell("Codename").appendChild(name);

        var behavior = document.createElement("select");
        var currentBehavior = (blockType.behavior || {name:""}).name;
        var o = document.createElement("option");
        o.textContent = "—";
        o.selected = name === currentBehavior;
        behavior.appendChild(o);
        Object.keys(Circuit.behaviors).forEach(function (name) {
          var o = document.createElement("option");
          o.textContent = name;
          o.value = name;
          o.selected = name === currentBehavior;
          behavior.appendChild(o);
        });
        behavior.onchange = function () {
          blockType.behavior = Circuit.behaviors[behavior.value];
          return true;
        };
        mkcell("Behavior").appendChild(behavior);

        var solid = document.createElement("input");
        solid.type = "checkbox";
        solid.checked = blockType.solid;
        solid.onchange = function () {
          blockType.solid = solid.checked;
          return true;
        };
        mkcell("Solid").appendChild(solid);

        var lightT = document.createElement("input");
        lightT.type = "number";
        lightT.min = 0;
        lightT.max = 4;
        lightT.value = blockType.light.toString();
        lightT.onchange = function () {
          lightR.value = lightT.value;
          blockType.light = parseFloat(lightT.value);
          return true;
        };
        var lightR = document.createElement("input");
        lightR.type = "range";
        lightR.min = 0;
        lightR.max = 4;
        lightR.step = "any";
        lightR.value = blockType.light.toString();
        lightR.onchange = function () {
          lightT.value = lightR.value;
          blockType.light = parseFloat(lightR.value);
          return true;
        };
        var lightCell = mkcell("Light emission");
        lightCell.appendChild(lightT);
        lightCell.appendChild(lightR);

      }()); else {
        panel.appendChild(mkelement("p", "", 
          mkelement("em", "", "No details available for this object.")));
      }
    };
    
    // --- Support ---
    
    var renderer = null;
    
    this.setRenderer = function (v) {
      renderer = v;
    };
  }
  
  ObjectUI.prototype.openPanelFromButton = function (name) {
    this.openPanel(name);
    this.refocus();
  };
  
  cubes.ObjectUI = Object.freeze(ObjectUI);
})();