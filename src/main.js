import './styles.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
//import { Mesh } from 'three';
import { WebGLRenderer } from "three";
import { SRGBColorSpace } from 'three';
import { EffectComposer, RenderPass, EffectPass, OutlineEffect, BlendFunction, SMAAEffect } from 'postprocessing';
import Stats from 'three/examples/jsm/libs/stats.module.js';

function isMobile() {
    return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

const IS_MOBILE = isMobile();
window.addEventListener('error', (e) => {
    console.error('💥 CRASH DETECTED:', e.message);
    alert('CRASH: ' + e.message + ' at line ' + e.lineno);
});

window.addEventListener('unhandledrejection', (e) => {
    console.error('💥 PROMISE CRASH:', e.reason);
    alert('PROMISE ERROR: ' + e.reason);
});

function formatList(text) {
    if (!text || typeof text !== 'string') return '';
    return text
        .replace(/\\n/g, '\n') // if you have escaped \n from CSV
        .split('\n')           // split on real line breaks
        .map(line => `<p>${line.trim()}</p>`)
        .join('');
}
class HotspotManager {
    constructor() {
        this.init();
        this.hotspots = [];
        this.doorAnimations = {};
        this.doorHotspots = [];
        this.hotspotsData = null;
        this.selectedHotspot = null;
        this.currentHotspotIndex = 0;

        this.currentHotspotIndex = 0;
        this.visitedHotspots = new Set();
        this.isAnimating = false;
        this.needsUpdate = false;
        this.frameCount = 0;
        // Performance settings
        this.LOD_DISTANCE = 10;
        this.CULL_DISTANCE = 50;
        this.targetFPS = 60;
        // Raycast optimization
        this.raycastThrottle = 0;
        this.raycastInterval = 3; // Only raycast every 3 frames
        this.lastRaycastResults = new Map();
        this.raycastCache = new Map();
        this.cacheTimeout = 500; // Cache results for 500ms

        // Frustum culling
        this.frustum = new THREE.Frustum();
        this.cameraMatrix = new THREE.Matrix4();

        // Object pooling for raycaster
        this.raycaster = new THREE.Raycaster();
        this.tempVector = new THREE.Vector3();
        this.tempVector2 = new THREE.Vector3();
        this.tempMatrix = new THREE.Matrix4();

        // Track camera/controls changes for hotspot update
        this.cameraChanged = true;
        this.controlsChanged = true;
        this.lastCameraPosition = new THREE.Vector3();
        this.lastCameraQuaternion = new THREE.Quaternion();

        this.isMuted = false;
        this.isPaused = false;
        this.currentAudio = null;
    }

    async init() {
        console.log('Initializing...');
        // Create scene
        this.scene = new THREE.Scene();
        this.clock = new THREE.Clock();

        const rgbeLoader = new RGBELoader();
        rgbeLoader.load('media/model/cannon_1k.hdr', (hdrTexture) => {
            hdrTexture.mapping = THREE.EquirectangularReflectionMapping;
            // Set filtering for environment map
            if (hdrTexture.minFilter !== undefined) hdrTexture.minFilter = THREE.LinearMipmapLinearFilter;
            if (hdrTexture.magFilter !== undefined) hdrTexture.magFilter = THREE.LinearFilter;
            hdrTexture.needsUpdate = true;
            this.scene.environment = hdrTexture;
            
        });

        // const bgLoader = new THREE.TextureLoader();
        // bgLoader.load('media/model/GradientBackground_2.png', (bgTexture) => {
        //     // Set filtering for background texture
        //     if (bgTexture.minFilter !== undefined) bgTexture.minFilter = THREE.LinearMipmapLinearFilter;
        //     if (bgTexture.magFilter !== undefined) bgTexture.magFilter = THREE.LinearFilter;
        //     bgTexture.needsUpdate = true;
        //     this.scene.background = bgTexture; // ✅ visible background
        // });
        const gradientCanvas = document.createElement('canvas');
        gradientCanvas.width = 1;
        gradientCanvas.height = 256;
        const ctx = gradientCanvas.getContext('2d');
        const gradient = ctx.createLinearGradient(0, 0, 0, 256);
        gradient.addColorStop(0, '#7C7C7C'); // bottom - white
        gradient.addColorStop(1, '#ffffff'); // top - light grey
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 1, 256);
        const gradientTexture = new THREE.CanvasTexture(gradientCanvas);
        this.scene.background = gradientTexture;

        // Create camera
        this.camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 1000);
        this.camera.position.set(0, 0, 0);
        this.camera.lookAt(0, 0, 0);

        // Create renderer
        this.renderer = new WebGLRenderer({
            powerPreference: "high-performance",
            antialias: window.devicePixelRatio <= 1,
            stencil: false,
            depth: true,
            alpha: false,
            //preserveDrawingBuffer: false
        });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(1);
        this.renderer.physicallyCorrectLights = true;
        this.renderer.outputEncoding = THREE.sRGBEncoding;
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        document.getElementById('container').appendChild(this.renderer.domElement);



        // Add WebGL context loss handler
        this.renderer.domElement.addEventListener('webglcontextlost', (event) => {
            event.preventDefault();
            alert('WebGL context lost. Please reload the page.');
        }, false);

        // Add right-center SVG arrow
        const MouseControl = document.createElement('img');
        MouseControl.src = 'media/MouseControl.svg'; // adjust path if needed
        MouseControl.id = 'mouse-control';
        document.body.appendChild(MouseControl);

        // 🔆 Enable tone mapping and adjust exposure
        this.renderer.toneMapping = THREE.LinearToneMapping; // or THREE.ReinhardToneMapping
        this.renderer.toneMappingExposure = 1; // adjust brightness here (try 1.2–2.0)
        this.renderer.outputEncoding = SRGBColorSpace;



        // Add lights
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.25);
        this.scene.add(ambientLight);

        const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
        directionalLight.position.set(0, 100, 0);
        directionalLight.intensity = 1; // more shadow strength
        directionalLight.castShadow = true;

        // Add these shadow properties
        directionalLight.shadow.mapSize.width = 512;
        directionalLight.shadow.mapSize.height = 512;
        directionalLight.shadow.radius = 4;
        directionalLight.shadow.bias = -0.0005;

        directionalLight.shadow.camera.near = 0.1;
        directionalLight.shadow.camera.far = 100;
        directionalLight.shadow.camera.left = -50;
        directionalLight.shadow.camera.right = 50;
        directionalLight.shadow.camera.top = 50;
        directionalLight.shadow.camera.bottom = -50;
        directionalLight.shadow.normalBias = 0.02;

        //Visualize the shadow frustum
        // const helper = new THREE.CameraHelper(directionalLight.shadow.camera);
        // this.scene.add(helper);

        directionalLight.shadow.camera.updateProjectionMatrix();
        this.scene.add(directionalLight);
        //composer
        // Setup composer only if not mobile
        this.composer = new EffectComposer(this.renderer);
        this.composer.addPass(new RenderPass(this.scene, this.camera));
        // Postprocessing passes

        // Create OutlineEffect
        this.outlineEffect = new OutlineEffect(this.scene, this.camera, {
            selection: [],
            blendFunction: BlendFunction.ALPHA,
            edgeStrength: 2,
            pulseSpeed: 0.0,
            visibleEdgeColor: new THREE.Color('#ef5337'), // Start transparent
            hiddenEdgeColor: new THREE.Color('#ef5337'),
            multisampling: 4,
            // resolution: {
            //     // width: window.innerWidth * Math.min(window.devicePixelRatio, 2),
            //     // height: window.innerHeight * Math.min(window.devicePixelRatio, 2)
            // },
            resolution: { width: window.innerWidth / 2, height: window.innerHeight / 2 },

            xRay: false,
            // Edge detection settings
            patternTexture: null,
            kernelSize: 1,
            blur: true,
            edgeGlow: 0.0,
            usePatternTexture: false
        });
        //SMAA
        const smaaEffect = new SMAAEffect();
        // Create effect pass with both outline and SMAA
        const effectPass = new EffectPass(this.camera, this.outlineEffect, smaaEffect);
        effectPass.renderToScreen = true;

        //add effect pass to composer
        this.composer.addPass(effectPass);

        // Add floor disc
        const floorGeometry = new THREE.CircleGeometry(70, 48);
        const floorMaterial = new THREE.MeshStandardMaterial({
            color: 0xbbbbbb,
            transparent: true,
            opacity: .7,
            roughness: 1.0,
            metalness: 0.0,
            side: THREE.DoubleSide
        });
        const floor = new THREE.Mesh(floorGeometry, floorMaterial);
        floor.rotation.x = -Math.PI / 2; // Rotate to be horizontal
        floor.position.y = -0; // Position lower below the model
        floor.position.z = -0;
        floor.position.x = 0;
        floor.receiveShadow = true;
        this.scene.add(floor);

        // Add controls
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true; // Enable smooth camera motion
        this.controls.dampingFactor = 0.15; // Increase damping for smoother stop
        this.controls.zoomSpeed = 2.0; // Increase zoom speed
        this.controls.enablePan = false;
        this.controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
        this.controls.mouseButtons.MIDDLE = THREE.MOUSE.DOLLY;
        this.controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;

        // Set orbit boundaries
        this.controls.minDistance = 0.1; // Minimum zoom distance
        this.controls.maxDistance = 80; // Maximum zoom distance
        this.controls.minPolarAngle = Math.PI / 6; // Minimum vertical angle (30 degrees)
        this.controls.maxPolarAngle = Math.PI / 1.6; // Maximum vertical angle (120 degrees)
        // this.controls.minAzimuthAngle = -Math.PI; // Allow full 360 rotation
        //this.controls.maxAzimuthAngle = Math.PI;
        this.controls.enablePan = true; // Disable panning to keep focus on the model
        this.controls.target.y = 0; // Keep the orbit target at floor level
        // Keep target from going below floor
        this.controls.addEventListener('change', () => {
            if (this.controls.target.y < 0) {
                this.controls.target.y = 0;
            }
        });
        // Track camera/controls changes for hotspot update
        this.controls.addEventListener('change', () => {
            this.controlsChanged = true;
        });

        // Setup loaders
        this.setupLoaders();

        try {
            // Load model and hotspots
            console.log('Loading model...');
            await this.loadModel();
            console.log('Model loaded successfully');
        } catch (error) {
            console.error('Error during initialization:', error);
            document.getElementById('loadingScreen').innerHTML = `
                        <div class="loading-content">
                            <h2>Error Loading Model</h2>
                            <p>${error.message}</p>
                            <p>Please ensure the model file is in the correct location.</p>
                        </div>
                    `;
        }
        window.addEventListener('orientationchange', () => {
            this.onWindowResize();
            setTimeout(() => this.onWindowResize(), 500); // double fire for safety
        });
        // Add event listeners
        // Debounced resize handler
        let resizeTimeout = null;
        window.addEventListener('resize', () => {
            if (resizeTimeout) clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(() => {
                this.onWindowResize();
                this.cameraChanged = true;
                this.controlsChanged = true;
            }, 100);
        });




        this.setupFullscreenButton();
        //this.setupTechSpecToggle();
        this.setupResetButton();
        this.setupChecklistButton();
        this.setupPlayPauseButton();
        this.setupMuteButton();
        //this.setupPDFButton();

        //test outliene box
        // const test = new THREE.Mesh(
        //     new THREE.BoxGeometry(1, 1, 1),
        //     new THREE.MeshStandardMaterial({ color: 0x00ff00 })
        // );
        // this.scene.add(test);
        // this.outlineEffect.selection.set([test]);
        this.stats = new Stats();
        //hide fps on screen
        //document.body.appendChild(this.stats.dom);
        // Start animation loop
        this.clock = new THREE.Clock();
        this.animate();
        console.log('Initialization complete');
    }

    setupLoaders() {
        // Setup DRACO loader
        this.dracoLoader = new DRACOLoader();
        this.dracoLoader.setDecoderPath('./lib/draco/');
        this.dracoLoader.preload();

        // Setup GLTF loader with loading manager
        const loadingManager = new THREE.LoadingManager();
        this.loader = new GLTFLoader(loadingManager);
        this.loader.setDRACOLoader(this.dracoLoader);
        this.loadingManager = loadingManager;
    }

    async loadModel() {
        return new Promise((resolve, reject) => {
            // Reuse loading manager
            const loadingManager = this.loadingManager;

            // Setup loading manager callbacks
            loadingManager.onProgress = (url, loaded, total) => {
                const progress = (loaded / total) * 100;
                document.getElementById('progress').style.width = progress + '%';
                console.log(`Loading progress: ${progress}%`);
            };

            loadingManager.onLoad = () => {
                const loadingEl = document.getElementById('loadingScreen');
                loadingEl.style.opacity = 0;
                setTimeout(() => {
                    loadingEl.style.display = 'none';
                }, 300); // Match CSS transition duration
                resolve();
            };

            loadingManager.onError = (url) => {
                console.error('Error loading:', url);
                reject(new Error(`Failed to load: ${url}`));
            };


            const modelPath = 'media/model/b737_callouts_v4.glb';
            console.log('Loading model from:', modelPath);

            // this.loader.load(modelPath, (gltf) => {
            //     console.log('Model loaded!');
            //     scene.add(gltf.scene);
            // }, undefined, (err) => {
            //     console.error('Failed to load model:', err);
            // });
            this.loader.load(
                modelPath,
                (gltf) => {
                    console.log('Model loaded successfully');

                    console.log("🔍 Checking material variants...");
                    // ✅ Get global variant list

                    this.model = gltf.scene;
                    // Store meshIndex for each mesh so we can reference default material later
                    gltf.scene.traverse((obj) => {
                        if (obj.isMesh) {
                            if (gltf.parser.json.meshes) {
                                const meshDefIndex = gltf.parser.json.meshes.findIndex(mesh => mesh.name === obj.name);
                                if (meshDefIndex !== -1) {
                                    obj.userData.meshIndex = meshDefIndex;
                                }
                            }
                        }
                    });

                    this.gltf = gltf;

                    //hide object after load
                    this.cableContentsObject = this.model.getObjectByName("CableBinContents");
                    if (this.cableContentsObject) {
                        this.cableContentsObject.visible = false;
                    }

                    // Setup animation mixer and register animations
                    this.mixer = new THREE.AnimationMixer(this.model);
                    this.animationMixers = {};
                    this.animationsByName = {};

                    gltf.animations.forEach((clip) => {
                        this.animationMixers[clip.name] = this.mixer;
                        this.animationsByName[clip.name] = clip;
                        console.log(`🎞️ Loaded animation: ${clip.name}`);
                    });

                    this.cameras = {};
                    gltf.scene.traverse(obj => {
                        if (obj.isCamera && obj.name.startsWith("Cam_")) {
                            const key = obj.name.replace("Cam_", ""); // Extract variant name
                            this.cameras[key] = obj;
                            console.log(`📸 Found camera: ${obj.name}`);
                        }
                    });
                    // ✅ Get global variant list
                    const variantExtension = gltf.parser.json.extensions?.KHR_materials_variants;
                    if (variantExtension && variantExtension.variants) {
                        this.variantList = variantExtension.variants.map(v => v.name);
                        console.log('✅ Material Variants Found:', this.variantList);
                    }

                    // Log all nodes in the model with their positions
                    console.log('=== Available Nodes in Model ===');
                    const nodePositions = {};
                    const targetNodes = ['Main_FrontView', 'Main_RearView', 'Main_LeftView', 'Main_RightView', '01_ChargingSocket'];

                    this.model.traverse((node) => {
                        if (node.isMesh || node.isObject3D) {
                            const position = new THREE.Vector3();
                            node.getWorldPosition(position);
                            nodePositions[node.name] = {
                                name: node.name,
                                type: node.type,
                                position: position
                            };

                            // Log all nodes
                            //console.log(`Node: "${node.name}" (Type: ${node.type}) Position:`, position);

                            // Specifically log target nodes if found
                            if (targetNodes.includes(node.name)) {
                                console.log('Found target node:', {
                                    name: node.name,
                                    position: position
                                });
                            }
                            //triangle counts
                            // let triangleCount = 0;
                            // this.model.traverse((obj) => {
                            //     if (obj.isMesh) {
                            //         const geom = obj.geometry;
                            //         triangleCount += geom.index ? geom.index.count / 3 : geom.attributes.position.count / 3;
                            //     }
                            // });
                            // console.log("🔺 Triangle count:", triangleCount);
                            this.interactiveMeshes = []; // ✅ New array for raycasting

                            this.model.traverse((node) => {
                                if (node.isMesh && node.visible) {
                                    this.interactiveMeshes.push(node); // ✅ Store raycastable mesh
                                }
                            });
                        }
                    });
                    this.interactiveMeshes = [];
                    this.model.traverse((node) => {
                        if (node.isMesh && node.visible) {
                            this.interactiveMeshes.push(node);
                        }
                    });

                    // Log summary of target nodes
                    console.log('=== Target Nodes Summary ===');
                    targetNodes.forEach(nodeName => {
                        if (nodePositions[nodeName]) {
                            console.log(`Found ${nodeName}:`, nodePositions[nodeName]);
                        } else {
                            console.log(`Node ${nodeName} not found in model`);
                        }
                    });
                    console.log('============================');

                    this.scene.add(this.model);

                    // Set texture filtering for all textures in model materials
                    this.model.traverse((node) => {
                        if (node.isMesh && node.material) {
                            const materials = Array.isArray(node.material) ? node.material : [node.material];
                            materials.forEach((mat) => {
                                [
                                    'map',
                                    'normalMap',
                                    'roughnessMap',
                                    'metalnessMap',
                                    'aoMap',
                                    'emissiveMap',
                                    'alphaMap',
                                    'bumpMap',
                                    'displacementMap',
                                    'specularMap',
                                    'envMap'
                                ].forEach((mapType) => {
                                    if (mat[mapType]) {
                                        mat[mapType].minFilter = THREE.LinearMipmapLinearFilter;
                                        mat[mapType].magFilter = THREE.LinearFilter;
                                        mat[mapType].needsUpdate = true;
                                    }
                                });

                                // ✅ Clearcoat check
                                // if ('clearcoat' in mat) {
                                //     console.log('✅ This material uses clearcoat.');
                                //     console.log('Clearcoat:', mat.clearcoat);
                                //     console.log('Clearcoat Roughness:', mat.clearcoatRoughness);
                                // }
                            });
                        }
                    });


                    //Center model
                    const box = new THREE.Box3().setFromObject(this.model);
                    //const center = box.getCenter(new THREE.Vector3());
                    //this.model.position.sub(center);

                    // 180 degrees in radians
                    this.model.rotation.y = Math.PI / 1.25;

                    // Store model dimensions for positioning hotspots
                    const size = box.getSize(new THREE.Vector3());
                    this.modelSize = size;

                    // Adjust camera
                    const maxDim = Math.max(size.x, size.y, size.z);
                    const fov = this.camera.fov * (Math.PI / 180);
                    let cameraZ = Math.abs(maxDim / Math.tan(fov / 2));
                    // Enforce a comfortable default reset distance (e.g., z=2)
                    const defaultResetDistance = 30;
                    this.camera.position.set(-450, 200, cameraZ * 2);
                    this.camera.lookAt(0, 0, 0);
                    this.camera.updateProjectionMatrix();


                    this.initialCameraPosition = new THREE.Vector3(-500, 150, cameraZ);
                    this.initialCameraTarget = new THREE.Vector3(0, 0, 0);
                    // Set orbit controls target to model center (orbit mode)
                    this.controls.target.set(0, 0, 0);
                    this.controls.update();
                    // Create hotspots after model is loaded
                    this.createDefaultHotspots();

                    // In the model loading section, add this after loading the model:
                    this.model.traverse((node) => {
                        if (node.isMesh) {
                            node.castShadow = true;
                            node.receiveShadow = true;

                            // Make sure materials are set up for shadows
                            if (node.material) {
                                node.material.shadowSide = THREE.FrontSide;
                                node.material.needsUpdate = true;
                            }
                        }
                    });

                    resolve();
                },
                (xhr) => {
                    const percent = xhr.loaded / xhr.total * 100;
                    console.log(`${percent}% loaded`);
                },
                (error) => {
                    console.error('Error loading model:', error);
                }
            );
        });
    }

    clearAllVariants() {
        if (!this.gltf) return;

        this.model.traverse((object) => {
            if (!object.isMesh) return;

            const ext = object.userData?.gltfExtensions?.KHR_materials_variants;

            if (ext?.mappings?.length) {
                // Find the fallback/default material from the GLTF definition
                const meshIndex = object.userData.meshIndex;
                if (meshIndex !== undefined) {
                    const meshDef = this.gltf.parser.json.meshes[meshIndex];
                    const primitive = meshDef?.primitives?.[0];

                    if (primitive?.material !== undefined) {
                        this.gltf.parser.getDependency('material', primitive.material).then((defaultMat) => {
                            object.material = defaultMat;
                            object.material.needsUpdate = true;
                        });
                    }
                }
            }
        });

        console.log('🔁 Reset all materials to their base (default) version');
    }

    handleHotspotClick(hotspot) {
        const hotspotData = hotspot.data;
        // Stop any currently playing audio
        if (this.currentAudio) {
            this.currentAudio.pause();
            this.currentAudio.currentTime = 0;
            this.currentAudio = null;
        }

        // Play audio for the current hotspot
        if (hotspotData.audio && !this.isMuted) {
            this.currentAudio = new Audio(hotspotData.audio);

            this.currentAudio.addEventListener('ended', () => {
                this.isPaused = false;
                document.getElementById('playPauseIcon').src = 'media/Play_default.svg';
            });

            this.currentAudio.play();
            this.isPaused = false;

            // Set icon to pause
            document.getElementById('playPauseIcon').src = 'media/Pause_default.svg';
        }
        // Deselect previous
        if (this.selectedHotspot && this.selectedHotspot !== hotspot) {
            this.visitedHotspots.add(this.selectedHotspot);

            // this.selectedHotspot.element.style.backgroundImage =
            //     this.selectedHotspot.data.type === 'animation'
            //         ? `url('media/door_visited.png')`
            //         : `url('media/Info_visited.png')`;
            // Add visited class for number circle hotspots
            if (this.selectedHotspot.element.classList.contains('hotspot-number')) {
                this.selectedHotspot.element.style.backgroundImage = 'none'; // clear old PNG
                this.selectedHotspot.element.classList.remove('selected');
                this.selectedHotspot.element.classList.add('visited');
            } else {
                // Keep old icon logic for animation hotspots
                this.selectedHotspot.element.style.backgroundImage =
                    this.selectedHotspot.data.type === 'animation'
                        ? `url('media/door_visited.png')`
                        : `url('media/Info_visited.png')`;
            }

            this.selectedHotspot.info.style.display = 'none';
            this.selectedHotspot.info.classList.remove('active');
        }
        // Mark current as selected
        if (hotspot.element.classList.contains('hotspot-number')) {
            hotspot.element.style.backgroundImage = 'none';
            hotspot.element.classList.remove('visited');
            hotspot.element.classList.add('selected');
        } else {
            hotspot.element.style.backgroundImage = hotspotData.type === 'animation'
                ? `url('media/door_selected.png')`
                : `url('media/Info_Selected.png')`;
        }
        this.selectedHotspot = hotspot;
        this.visitedHotspots.add(hotspot);


        // ✅ Always show the info panel, including description
        hotspot.info.style.display = 'block';
        hotspot.info.classList.add('active');

        // 🔁 Move to predefined camera position if available
        const cameraNode = this.gltf.scene.getObjectByName('Cam_' + hotspotData.node);
        const hotspotNode = this.model.getObjectByName(hotspotData.node);
        if (cameraNode && cameraNode.isCamera && hotspotNode) {
            const endPos = new THREE.Vector3();
            cameraNode.getWorldPosition(endPos);
            const endTarget = new THREE.Vector3();
            hotspotNode.getWorldPosition(endTarget);
            const startPos = this.camera.position.clone();
            const startTarget = this.controls.target.clone();
            // Animate both camera position and controls.target (orbit center)
            const duration = 1500;
            const startTime = Date.now();
            const animate = () => {
                const elapsed = Date.now() - startTime;
                const t = Math.min(elapsed / duration, 1);
                const ease = 1 - Math.pow(1 - t, 4);
                this.camera.position.lerpVectors(startPos, endPos, ease);
                this.controls.target.lerpVectors(startTarget, endTarget, ease);
                this.controls.update();
                if (t < 1) {
                    requestAnimationFrame(animate);
                }
            };
            animate();
        } else {
            this.moveToHotspotView(hotspot);
        }

        //outline seleected mesh
        const meshToOutline = this.model.getObjectByName(hotspotData.node);
        if (meshToOutline) {
            const meshesToSelect = [];

            // If the node is a group or has children, traverse it
            meshToOutline.traverse((child) => {
                if (child.isMesh) {
                    meshesToSelect.push(child);
                }
            });

            // If it is a single mesh with multiple materials, still push it
            if (meshToOutline.isMesh && meshesToSelect.length === 0) {
                meshesToSelect.push(meshToOutline);
            }

            if (meshesToSelect.length > 0) {
                this.outlineEffect.selection.set(meshesToSelect);
                this.animateOutlineEdgeStrength(0, 5, 1500);
                console.log('✔ Outline applied to:', meshesToSelect.map(m => m.name));
            } else {
                console.warn('❌ No mesh found to apply outline for:', hotspotData.node);
            }
        } else {
            console.warn('❌ Node not found in model:', hotspotData.node);
        }
        // 🔁 Sync checklist with hotspot
        if (this.checklistData) {
            const stepIndex = this.checklistData.findIndex(step => step.node === hotspotData.node);
            if (stepIndex !== -1) {
                const allItems = document.querySelectorAll('#checklist li');
                allItems.forEach(item => item.classList.remove('open'));

                // Get the checklist item
                const li = document.querySelectorAll('#checklist li')[stepIndex];
                const checkbox = li.querySelector('.custom-checkbox');

                // Mark it as checked
                checkbox.classList.add('checked');
                li.classList.add('open');
                this.completedSteps.add(stepIndex);
                this.updateProgress();

                // Only scroll if the checklist container is visible
                const checklistContainer = document.getElementById('checklist-container');
                // Show the checklist panel if it's hidden
                if (checklistContainer) {
                    checklistContainer.style.display = 'block';
                    checklistContainer.classList.remove('hidden'); // optional
                }

                if (checklistContainer && checklistContainer.style.display === 'block') {
                    li.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }
        }

        // 🔁 Sync navigation index
        const idx = this.allHotspots.findIndex(h => h.node === hotspotData.node);
        if (idx !== -1) {
            this.currentHotspotIndex = idx;
            this.updateTitleDisplay();
        }
    }

    async createDefaultHotspots() {
        //option1 use json for hotspot info
        // const response = await fetch('hotspots.json');
        // const hotspotDataList = await response.json();

        //option2 use cvs for hotspot info
        const hotspotDataList = await new Promise((resolve, reject) => {
            Papa.parse('walkaround_steps_nodes.csv', {
                download: true,
                header: true,
                complete: results => {
                    // filter out empty rows
                    this.checklistData = results.data.filter(row =>
                        row.node?.trim() && row.title?.trim()
                    );

                    console.log(`Checklist steps loaded: ${this.checklistData.length}`);

                    const cleaned = results.data.filter(row => row.node && row.title);
                    resolve(cleaned);
                },
                error: err => reject(err)
            });
        });
        // Store the full list of hotspots for navigation
        this.allHotspots = hotspotDataList.filter(h => h.type !== 'camera');

        // 🔎 Filter camera hotspots from JSON
        const cameraHotspots = hotspotDataList.filter(h => h.type === 'camera');

        const cameraControls = document.getElementById("cameraControls");
        cameraControls.innerHTML = ''; // Clear existing

        // 🔁 Generate buttons
        cameraHotspots.forEach(camData => {
            const container = document.createElement("div");
            container.className = "cam-btn-container";

            const label = document.createElement("span");
            label.textContent = camData.title;
            label.className = "cam-btn-label";

            container.addEventListener("click", () => {
                document.querySelectorAll(".cam-btn-container.active").forEach(el => {
                    el.classList.remove("active");
                });

                container.classList.add("active");
                const cameraNode = this.model.getObjectByName(camData.camera);
                // match Blender FOV
                if (cameraNode && cameraNode.isCamera) {
                    this.camera.fov = THREE.MathUtils.radToDeg(cameraNode.fov);
                    this.camera.updateProjectionMatrix();
                }

                if (!cameraNode || !cameraNode.isCamera) {
                    console.warn('❌ Camera not found:', camData.camera);
                    return;
                }

                const targetPos = new THREE.Vector3();
                cameraNode.getWorldPosition(targetPos);
                const targetQuat = new THREE.Quaternion();
                cameraNode.getWorldQuaternion(targetQuat);
                const startPos = this.camera.position.clone();
                const startQuat = this.camera.quaternion.clone();
                const startTarget = this.controls.target.clone();

                let endTarget;
                if (camData.title === 'Exterior') {
                    // For exterior camera, always orbit model center
                    endTarget = new THREE.Vector3(0, 0, 0);
                } else {
                    // For other cameras, orbit the camera's look-at point
                    endTarget = new THREE.Vector3(0, 0, -1).applyQuaternion(targetQuat).add(targetPos);
                }

                const duration = 1000;
                const startTime = Date.now();

                const animate = () => {
                    const elapsed = Date.now() - startTime;
                    const t = Math.min(elapsed / duration, 1);
                    const ease = 1 - Math.pow(1 - t, 4);

                    this.camera.position.lerpVectors(startPos, targetPos, ease);
                    this.camera.quaternion.slerpQuaternions(startQuat, targetQuat, ease);
                    this.controls.target.lerpVectors(startTarget, endTarget, ease);
                    this.controls.update();

                    if (t < 1) requestAnimationFrame(animate);
                };

                animate();
            });

            container.appendChild(label);
            cameraControls.appendChild(container);
        });

        document.addEventListener("click", (e) => {
            const clickedInside = e.target.closest(".cam-btn-container");
            if (!clickedInside) {
                document.querySelectorAll(".cam-btn-container.active").forEach(el => {
                    el.classList.remove("active");
                });
            }
        });

        // Navigation buttons setup (merged here)
        const prevBtn = document.getElementById('prevHotspotBtn');
        const nextBtn = document.getElementById('nextHotspotBtn');
        const titleDisplay = document.getElementById('currentHotspotTitle');

        // Set initial text
        this.currentHotspotIndex = -1
        titleDisplay.textContent = "Click a hotspot or use arrows";

        const navigateToHotspot = (index) => {
            if (!this.allHotspots || this.allHotspots.length === 0) return;

            // If we're in title state (-1), start navigation from the requested direction
            if (this.currentHotspotIndex === -1) {
                if (index < -1) {
                    // Going backwards from title should go to last hotspot
                    this.currentHotspotIndex = this.allHotspots.length - 1;
                } else {
                    // Going forwards from title should go to first hotspot
                    this.currentHotspotIndex = 0;
                }
            } else {
                // Normal navigation - wrap around at boundaries
                if (index < 0) {
                    // Going backwards from first hotspot wraps to last
                    this.currentHotspotIndex = this.allHotspots.length - 1;
                } else if (index >= this.allHotspots.length) {
                    // Going forwards from last hotspot wraps to first
                    this.currentHotspotIndex = 0;
                } else {
                    this.currentHotspotIndex = index;
                }
            }

            // Show the hotspot
            const hotspotData = this.allHotspots[this.currentHotspotIndex];
            const hotspot = this.hotspots.find(h => h.data.node === hotspotData.node);
            if (hotspot) {
                this.handleHotspotClick(hotspot);
            }

            this.updateTitleDisplay();
        };

        prevBtn.addEventListener('click', () => {
            navigateToHotspot(this.currentHotspotIndex - 1);
        });

        nextBtn.addEventListener('click', () => {
            navigateToHotspot(this.currentHotspotIndex + 1);
        });

        hotspotDataList.forEach((hotspotData, index) => {
            if (hotspotData.type === 'camera') return;

            let node = this.model.getObjectByName(hotspotData.node);
            if (!node) {
                this.model.traverse(child => {
                    if (!node && child.name.startsWith(hotspotData.node)) {
                        node = child;
                    }
                    if (child.isMesh) {
                        child.castShadow = true;
                    }
                });
            }

            if (!node) {
                console.warn(`❌ Could not find node for: ${hotspotData.node}`);
                return;
            }

            const worldPosition = new THREE.Vector3();
            node.getWorldPosition(worldPosition);

            const hotspotDiv = document.createElement('div');
            hotspotDiv.className = 'hotspot';
            // hotspotDiv.style.backgroundImage = hotspotData.type === 'animation'
            //     ? `url('media/door_default.png')`
            //     : `url('media/Info_default.png')`;
            if (hotspotData.type === 'animation') {
                hotspotDiv.style.backgroundImage = `url('media/door_default.png')`;
            } else {
                hotspotDiv.classList.add('hotspot-number');
                hotspotDiv.style.backgroundImage = 'none'; // clear old PNG
                hotspotDiv.textContent = index + 1; // number starts at 1
            }
            document.body.appendChild(hotspotDiv);

            const infoDiv = document.createElement('div');
            infoDiv.className = 'hotspot-info';
            // Check if it's mobile or desktop
            const isMobileView = window.innerWidth <= 600;

            infoDiv.innerHTML = `
                <img class="closeSpecIcon" src="media/Close.png" alt="Close" />
                <div class="text-scroll">
                    <div class="hotspot-title">${hotspotData.title}</div>

                    ${isMobileView ? `<div class="hotspot-description">${hotspotData.description}</div>` : ''}
                </div>
                <div class="bottom-blocker"></div>
            `;
            document.body.appendChild(infoDiv);

            // Add working close logic
            const closeBtn = infoDiv.querySelector('.closeSpecIcon');
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                infoDiv.style.display = 'none';
                infoDiv.classList.remove('active');

                // Deselect logic if you're using this.selectedHotspot
                if (this.selectedHotspot && this.selectedHotspot.info === infoDiv) {
                    // Handle number hotspots separately
                    if (this.selectedHotspot.element.classList.contains('hotspot-number')) {
                        this.selectedHotspot.element.style.backgroundImage = 'none';
                        this.selectedHotspot.element.classList.remove('selected');
                        this.selectedHotspot.element.classList.add('visited');
                    } else {
                        // Fallback to old PNG logic for animation hotspots
                        this.selectedHotspot.element.style.backgroundImage = this.selectedHotspot.data.type === 'animation'
                            ? `url('media/door_visited.png')`
                            : `url('media/Info_visited.png')`;
                    }

                    this.selectedHotspot = null;
                    // Clear outline effect
                    if (this.outlineEffect && this.outlineEffect.selection) {
                        this.outlineEffect.selection.clear();
                    }
                }
            });

            const geometry = new THREE.SphereGeometry(0.01);
            const material = new THREE.MeshBasicMaterial({ visible: false });
            const hotspotMesh = new THREE.Mesh(geometry, material);
            hotspotMesh.position.copy(worldPosition);
            this.scene.add(hotspotMesh);

            const hotspot = {
                element: hotspotDiv,
                info: infoDiv,
                data: hotspotData,
                mesh: hotspotMesh
            };

            this.hotspots.push(hotspot);

            if (!this.visitedHotspots) {
                this.visitedHotspots = new Set();
            }

            hotspotDiv.addEventListener('click', () => {
                this.handleHotspotClick(hotspot);
            });
            // Touch support for hotspot
            hotspotDiv.addEventListener('touchstart', (e) => {
                e.preventDefault();
                hotspotDiv.click();
            });

            hotspotDiv.addEventListener('mouseenter', () => {
                if (hotspotDiv.classList.contains('hotspot-number')) {
                    // For number circles → mark selected only if not visited
                    if (!this.visitedHotspots.has(hotspot) && this.selectedHotspot !== hotspot) {
                        hotspotDiv.classList.add('selected');
                    }
                } else {
                    // Original icon logic
                    if (this.selectedHotspot !== hotspot) {
                        hotspotDiv.style.backgroundImage = hotspotData.type === "animation"
                            ? `url('media/door_selected.png')`
                            : `url('media/Info_Selected.png')`;
                    }
                }

                infoDiv.style.display = 'block';
            });

            hotspotDiv.addEventListener('mouseleave', () => {
                if (hotspotDiv.classList.contains('hotspot-number')) {
                    // Remove hover/selected class if it's not the active one
                    if (this.selectedHotspot !== hotspot) {
                        hotspotDiv.classList.remove('selected');
                        if (this.visitedHotspots.has(hotspot)) {
                            hotspotDiv.classList.add('visited');
                        }
                    }
                } else {
                    // old image logic
                    hotspotDiv.style.backgroundImage = hotspotData.type === "animation"
                        ? `url('media/door_default.png')`
                        : `url('media/Info_default.png')`;
                }

                if (this.selectedHotspot !== hotspot) {
                    infoDiv.style.display = 'none';
                }
            });
        });
        // Ensure hotspots are visible by default after all are created
        this.cameraChanged = false;
        this.controlsChanged = true;
        this.updateHotspotPositions();
        if (!IS_MOBILE) {
            this.updateHotspotPositions();
        }

    }

    updateTitleDisplay() {
        const titleDisplay = document.getElementById('currentHotspotTitle');
        if (this.allHotspots && this.allHotspots.length > 0) {
            const hotspot = this.allHotspots[this.currentHotspotIndex];
            titleDisplay.innerHTML = `<span>${hotspot.displayTitle || hotspot.title}</span>`;
        }
    }

    switchToNamedCamera(cameraName) {
        const camNode = this.namedCameras?.[cameraName];
        if (!camNode) {
            console.warn(`Camera '${cameraName}' not found.`);
            return;
        }

        const startPos = this.camera.position.clone();
        const startQuat = this.camera.quaternion.clone();
        const targetPos = camNode.position.clone();
        const targetQuat = camNode.quaternion.clone();

        const startTime = Date.now();
        const duration = 1500;

        const animateSwitch = () => {
            const elapsed = Date.now() - startTime;
            const t = Math.min(elapsed / duration, 1);
            const ease = 1 - Math.pow(1 - t, 4);

            this.camera.position.lerpVectors(startPos, targetPos, ease);
            this.camera.quaternion.slerpQuaternions(startQuat, targetQuat, ease);

            this.controls.target.set(0, 0, 0); // optionally modify
            this.controls.update();

            if (t < 1) requestAnimationFrame(animateSwitch);
        };

        animateSwitch();
    }

    applyMaterialVariant(variantName) {
        if (!this.gltf || !variantName) return;

        const variantDefs = this.gltf.parser.json.extensions?.KHR_materials_variants?.variants;
        const variantIndex = variantDefs?.findIndex(v => v.name === variantName);

        if (variantIndex === -1 || variantIndex === undefined) {
            console.warn('❌ Variant not found:', variantName);
            return;
        }

        this.model.traverse((object) => {
            const ext = object.userData?.gltfExtensions?.KHR_materials_variants;
            if (!object.isMesh || !ext || !ext.mappings) return;

            const mapping = ext.mappings.find(m => m.variants.includes(variantIndex));
            if (mapping && mapping.material !== undefined) {
                this.gltf.parser.getDependency('material', mapping.material).then((newMat) => {
                    object.material = newMat;
                    object.material.needsUpdate = true;
                });
            }
        });

        console.log(`🎨 Applied variant: ${variantName}`);
    }

    moveToHotspotView(hotspot) {
        const camNodeName = `Cam_${hotspot.data.node}`;
        const camNode = this.model.getObjectByName(camNodeName);
        const hotspotNode = this.model.getObjectByName(hotspot.data.node);
        if (camNode && camNode.isObject3D && hotspotNode) {
            const endPos = new THREE.Vector3();
            camNode.getWorldPosition(endPos);
            const endTarget = new THREE.Vector3();
            hotspotNode.getWorldPosition(endTarget);
            const startPos = this.camera.position.clone();
            const startTarget = this.controls.target.clone();
            // Animate both camera position and controls.target (orbit center)
            const duration = 1500;
            const startTime = Date.now();
            const animate = () => {
                const elapsed = Date.now() - startTime;
                const t = Math.min(elapsed / duration, 1);
                const ease = 1 - Math.pow(1 - t, 4);
                this.camera.position.lerpVectors(startPos, endPos, ease);
                this.controls.target.lerpVectors(startTarget, endTarget, ease);
                this.controls.update();
                if (t < 1) {
                    requestAnimationFrame(animate);
                }
            };
            animate();
        } else {
            console.warn(`❌ No camera node or hotspot node found for: ${camNodeName}`);
        }
    }

    moveCameraTo(positionArray, quaternionArray) {
        const startPos = this.camera.position.clone();
        const startQuat = this.camera.quaternion.clone();

        const targetPos = new THREE.Vector3().fromArray(positionArray);
        const targetQuat = new THREE.Quaternion().fromArray(quaternionArray);

        const startTarget = this.controls.target.clone();
        const endTarget = new THREE.Vector3(0, 0, -1).applyQuaternion(targetQuat).add(targetPos);

        const duration = 1000;
        const startTime = Date.now();

        const animate = () => {
            const elapsed = Date.now() - startTime;
            const t = Math.min(elapsed / duration, 1);
            const ease = 1 - Math.pow(1 - t, 4);

            this.camera.position.lerpVectors(startPos, targetPos, ease);
            this.camera.quaternion.slerpQuaternions(startQuat, targetQuat, ease);
            this.controls.target.lerpVectors(startTarget, endTarget, ease);
            this.controls.update();

            if (t < 1) requestAnimationFrame(animate);
        };

        animate();
    }

    updateHotspotPositions() {
        if (!this.hotspots) return;

        // Only update if camera or controls have changed
        const camPos = this.camera.position;
        const camQuat = this.camera.quaternion;
        if (
            !this.cameraChanged &&
            !this.controlsChanged &&
            camPos.equals(this.lastCameraPosition) &&
            camQuat.equals(this.lastCameraQuaternion)
        ) {
            return;
        }
        this.lastCameraPosition.copy(camPos);
        this.lastCameraQuaternion.copy(camQuat);
        this.cameraChanged = false;
        this.controlsChanged = false;


        // Always raycast every frame for more stable results
        this.hotspots.forEach((hotspot) => {
            // Get world position
            const worldPosition = new THREE.Vector3();
            hotspot.mesh.getWorldPosition(worldPosition);

            // Project to screen coordinates
            const screenPosition = worldPosition.clone().project(this.camera);
            const isBehindCamera = screenPosition.z > 1;
            const isInView = screenPosition.x >= -1 && screenPosition.x <= 1 &&
                screenPosition.y >= -1 && screenPosition.y <= 1;

            const x = (screenPosition.x + 1) * window.innerWidth / 2;
            const y = (-screenPosition.y + 1) * window.innerHeight / 2;

            // Raycast to detect occlusion
            const direction = worldPosition.clone().sub(this.camera.position).normalize();
            this.raycaster.set(this.camera.position, direction);
            const intersects = this.raycaster.intersectObjects(this.interactiveMeshes, true);
            const distanceToHotspot = this.camera.position.distanceTo(worldPosition);
            const isOccluded = intersects.length > 0 && intersects[0].distance + 0.1 < distanceToHotspot;

            // Update visibility using opacity transition
            const shouldShow = !(isBehindCamera || !isInView || isOccluded);
            hotspot.element.style.opacity = shouldShow ? '1' : '0';
            hotspot.element.style.pointerEvents = shouldShow ? 'auto' : 'none';

            // Position updates
            hotspot.element.style.left = `${x}px`;
            hotspot.element.style.top = `${y}px`;

            // Handle info panel
            const showInfo = shouldShow && (hotspot === this.selectedHotspot || hotspot.element.matches(':hover'));
            hotspot.info.style.opacity = showInfo ? '1' : '0';
            hotspot.info.style.pointerEvents = showInfo ? 'auto' : 'none';


            function isMobileView() {
                return window.innerWidth < 600 || window.innerHeight < 400;
            }

            if (isMobileView()) {
                if (hotspot === this.selectedHotspot) {
                    hotspot.info.classList.add('mobile-fixed');
                    hotspot.info.style.left = '';
                    hotspot.info.style.top = '';
                } else {
                    hotspot.info.classList.remove('mobile-fixed');
                    if (hotspot.info.style.left !== `${x + 20}px`) hotspot.info.style.left = `${x + 20}px`;
                    if (hotspot.info.style.top !== `${y}px`) hotspot.info.style.top = `${y}px`;
                }
            } else {
                hotspot.info.classList.remove('mobile-fixed');
                if (hotspot.info.style.left !== `${x + 20}px`) hotspot.info.style.left = `${x + 20}px`;
                if (hotspot.info.style.top !== `${y}px`) hotspot.info.style.top = `${y}px`;
            }
        });
    }

    onWindowResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();

        const pixelRatio = Math.min(window.devicePixelRatio, 2);
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(1); // or just 1.0 for testing


        // Update composer
        this.composer.setSize(window.innerWidth, window.innerHeight);
        //this.composer.setPixelRatio(pixelRatio); // This line was causing the error

        // Update outline effect resolution with proper scaling
        if (this.outlineEffect && this.outlineEffect.resolution) {
            this.outlineEffect.resolution.width = window.innerWidth * pixelRatio;
            this.outlineEffect.resolution.height = window.innerHeight * pixelRatio;

            // Force update of internal render targets
            this.outlineEffect.setSize(window.innerWidth * pixelRatio, window.innerHeight * pixelRatio);
        }
    }

    setupFullscreenButton() {
        const button = document.getElementById('fullscreenBtn');
        button.addEventListener('click', () => {
            if (!document.fullscreenElement) {
                document.documentElement.requestFullscreen();
            } else {
                document.exitFullscreen();
            }
        });
    }
    setupPDFButton() {
        const button = document.getElementById('pdfBtn');
        const icon = document.getElementById('pdfIcon');

        button.addEventListener('click', () => {
            // Replace with the path to your PDF
            const pdfUrl = 'media/65P10AR_Rev02_12-24.pdf';

            // Open in a new tab
            window.open(pdfUrl, '_blank');
        });
        // button.addEventListener('mouseenter', () => {
        //     icon.src = 'media/PDF_active.svg';
        // });

        button.addEventListener('mouseleave', () => {
            icon.src = 'media/PDF_default.svg';
        });
    }

    updateProgress() {
        const total = this.checklistData.length;
        const done = this.completedSteps.size;
        const progressPercent = (done / total) * 100;

        const progressBar = document.getElementById('checklist-progress');
        if (progressBar) {
            progressBar.style.width = `${progressPercent}%`;
        }

        // Strike-through completed list items
        document.querySelectorAll('#checklist li').forEach((li, idx) => {
            if (this.completedSteps.has(idx)) {
                li.classList.add('completed');
            } else {
                li.classList.remove('completed');
            }
        });
    }



    goToStep(index) {
        const step = this.checklistData[index];

        // Focus on camera and outline node
        // this.focusOnStep(step);

        // Add step as completed
        this.completedSteps.add(index);

        // Update checkbox UI
        const checkbox = document.querySelector(
            `.custom-checkbox[data-index="${index}"]`
        );
        if (checkbox) {
            checkbox.classList.add('checked');
        }

        // Update progress bar & completed style
        this.updateProgress();
    }


    async buildChecklistUI() {
        const list = document.getElementById('checklist');
        list.innerHTML = '';

        // Parse CSV (PapaParse)
        const data = await new Promise((resolve, reject) => {
            Papa.parse('walkaround_steps_nodes.csv', {
                download: true,
                header: true,
                complete: results => resolve(results.data),
                error: err => reject(err)
            });
        });

        this.checklistData = data;
        this.completedSteps = new Set();

        data.forEach((step, index) => {
            //skip empty rows
            if (!step || !step.node) return;
            const li = document.createElement('li');
            li.classList.add('step-item');

            // Header row (checkbox + title + arrow)
            const header = document.createElement('div');
            header.className = 'step-header';

            const checkbox = document.createElement('span');
            checkbox.className = 'custom-checkbox';
            checkbox.dataset.index = index;

            const stepNumber = index + 1;
            const titleRow = document.createElement('div');
            titleRow.className = 'step-title';
            titleRow.innerHTML = `<span class="step-title-text">${stepNumber}. ${step.title}</span>`;


            const arrow = document.createElement('span');
            arrow.className = 'arrow-icon'; // arrow icon that rotates

            header.appendChild(checkbox);
            header.appendChild(titleRow);
            header.appendChild(arrow);

            // Description (hidden by default)
            const descRow = document.createElement('div');
            descRow.className = 'step-description';
            descRow.textContent = step.description;

            // Convert `\n\n` or `\n` into paragraphs
            descRow.innerHTML = formatList(step.description || '') || '<p>No description available</p>';


            // Toggle dropdown on header click
            header.addEventListener('click', () => {
                // Close all other dropdowns (accordion style)
                document.querySelectorAll('#checklist li').forEach(item => {
                    if (item !== li) {
                        item.classList.remove('open');
                    }
                });
                li.classList.toggle('open');
                // 🔹 Auto trigger hotspot when opened
                if (li.classList.contains('open')) {
                    const step = this.checklistData[index];
                    const hotspot = this.hotspots.find(h => h.data.node === step.node);
                    if (hotspot) {
                        this.handleHotspotClick(hotspot);
                    }
                }
            });

            // Checkbox click expands, checks, and moves to camera
            checkbox.addEventListener('click', (e) => {
                e.stopPropagation();

                // Expand the checklist item
                document.querySelectorAll('#checklist li').forEach(item => item.classList.remove('open'));
                li.classList.add('open');

                // Check/uncheck
                checkbox.classList.toggle('checked');
                if (checkbox.classList.contains('checked')) {
                    this.completedSteps.add(index);
                } else {
                    this.completedSteps.delete(index);
                }
                this.updateProgress();

                // Move camera and show hotspot
                const step = this.checklistData[index];
                const hotspot = this.hotspots.find(h => h.data.node === step.node);
                if (hotspot) {
                    this.handleHotspotClick(hotspot); // handles camera move + info display
                }
            });

            // Clicking title/camera jump auto-checks + opens dropdown
            titleRow.addEventListener('click', (e) => {
                e.stopPropagation();
                this.goToStep(index);
                li.classList.add('open');
                // 🔹 Trigger the correct hotspot view
                const step = this.checklistData[index];
                const hotspot = this.hotspots.find(h => h.data.node === step.node);
                if (hotspot) {
                    this.handleHotspotClick(hotspot); // this will move camera + show info panel
                }
            });

            li.appendChild(header);
            li.appendChild(descRow);
            list.appendChild(li);
        });



    }


    setupChecklistButton() {
        const button = document.getElementById('checklistBtn');
        const icon = document.getElementById('checklistIcon');
        const closeIcon = document.getElementById('closeChecklistIcon');
        const checklistContainer = document.getElementById('checklist-container');

        // Check if it's mobile (width ≤ 600px)
        const isMobileView = window.innerWidth <= 600;

        // Set initial visibility: show for desktop, hide for mobile
        let isVisible = !isMobileView;

        if (isVisible) {
            checklistContainer.style.display = 'block';
            icon.src = 'media/checklist_active.svg';
        } else {
            checklistContainer.style.display = 'none';
            icon.src = 'media/checklist_default.svg';
        }

        // Build checklist immediately (so it's ready either way)
        this.buildChecklistUI().then(() => {
            this.checklistBuilt = true;
        });

        const hideChecklist = () => {
            checklistContainer.style.display = 'none';
            icon.src = 'media/checklist_default.svg';
        };

        const showChecklist = async () => {
            checklistContainer.style.display = 'block';
            icon.src = 'media/checklist_active.svg';

            // Build checklist only if not already built
            if (!this.checklistBuilt) {
                await this.buildChecklistUI();
                this.checklistBuilt = true;
            }
        };

        // Close icon hides checklist
        closeIcon.addEventListener('click', () => {
            hideChecklist();
            isVisible = false;
        });

        // Toggle on icon button click
        button.addEventListener('click', async () => {
            if (isVisible) {
                hideChecklist();
            } else {
                await showChecklist();
            }
            isVisible = !isVisible;
        });
    }


    setupResetButton() {
        const button = document.getElementById('resetBtn');
        const icon = document.getElementById('resetIcon');

        button.addEventListener('click', () => {
            console.log('🔄 Resetting view...');

            // Enforce reset to a comfortable distance and allow zooming
            const targetPos = this.initialCameraPosition.clone();
            const targetTarget = this.initialCameraTarget.clone();
            const startPos = this.camera.position.clone();
            const startTarget = this.controls.target.clone();
            const duration = 2000;
            const startTime = Date.now();
            const animateReset = () => {
                const elapsed = Date.now() - startTime;
                const t = Math.min(elapsed / duration, 1);
                const ease = 1 - Math.pow(1 - t, 4);
                this.camera.position.lerpVectors(startPos, targetPos, ease);
                this.controls.target.lerpVectors(startTarget, targetTarget, ease);
                this.controls.update();
                if (t < 1) {
                    requestAnimationFrame(animateReset);
                } else {
                    this.controls.update();
                }
            };
            animateReset();

            // Reset material variant
            this.applyMaterialVariant('00_Default');
            this.outlineEffect.selection.clear();
            // Hide any open callout
            if (this.selectedHotspot) {
                this.selectedHotspot.info.classList.remove('active');
                this.selectedHotspot.info.style.display = 'none';
                this.selectedHotspot.element.style.backgroundImage = `url('media/Info_visited.png')`;
                this.selectedHotspot = null;
            }

            // Reset button icon after click
            setTimeout(() => {
                icon.src = 'media/Reset_default.svg';
            }, 150);
        });

        button.addEventListener('mouseenter', () => {
            icon.src = 'media/Reset_active.svg';
        });

        button.addEventListener('mouseleave', () => {
            icon.src = 'media/Reset_default.svg';
        });
    }

    setupPlayPauseButton() {
        const playPauseBtn = document.getElementById('playPauseBtn');
        const playPauseIcon = document.getElementById('playPauseIcon');

        playPauseBtn.addEventListener('click', () => {
            if (this.currentAudio) {
                if (this.currentAudio.paused) {
                    this.currentAudio.play();
                    this.isPaused = false;
                    playPauseIcon.src = 'media/Pause_default.svg';
                } else {
                    this.currentAudio.pause();
                    this.isPaused = true;
                    playPauseIcon.src = 'media/Play_default.svg';
                }
            }
        });
        // 🔹 Add hover events
        playPauseBtn.addEventListener('mouseenter', () => {
            if (this.currentAudio && !this.currentAudio.paused) {
                playPauseIcon.src = 'media/Pause_active.svg';
            } else {
                playPauseIcon.src = 'media/Play_active.svg';
            }
        });

        playPauseBtn.addEventListener('mouseleave', () => {
            if (this.currentAudio && !this.currentAudio.paused) {
                playPauseIcon.src = 'media/Pause_default.svg';
            } else {
                playPauseIcon.src = 'media/Play_default.svg';
            }
        });
    }
    setupMuteButton() {
        const muteBtn = document.getElementById('muteBtn');
        const muteIcon = document.getElementById('muteIcon');

        muteBtn.addEventListener('click', () => {
            this.isMuted = !this.isMuted;

            if (this.currentAudio) {
                if (this.isMuted) {
                    this.previousVolume = this.currentAudio.volume || 1; // Save current volume
                    this.currentAudio.volume = 0;
                    muteIcon.src = 'media/Mute_default.svg';
                } else {
                    this.currentAudio.volume = this.previousVolume || 1;
                    muteIcon.src = 'media/Unmute_default.svg';
                }
            }
        });

        // 🔹 Add hover events
        muteBtn.addEventListener('mouseenter', () => {
            muteIcon.src = this.isMuted
                ? 'media/Mute_active.svg'
                : 'media/Unmute_active.svg';
        });

        muteBtn.addEventListener('mouseleave', () => {
            muteIcon.src = this.isMuted
                ? 'media/Mute_default.svg'
                : 'media/Unmute_default.svg';
        });
    }


    setupTechSpecToggle() {
        const button = document.getElementById('techSpecBtn');
        const icon = document.getElementById('techSpecIcon');
        const modal = document.getElementById('specModal');
        const content = document.getElementById('specContent');
        const closeIcon = document.getElementById('closeSpecIcon');

        // Track toggle state
        let isVisible = false;

        const showSpecs = async () => {
            try {
                const response = await fetch('specs.json');
                const specs = await response.json();
                content.innerHTML = '';

                for (const [key, value] of Object.entries(specs)) {
                    if (value === "") {
                        const section = document.createElement('h2');
                        section.className = 'spec-section';
                        section.textContent = key;
                        content.appendChild(section);
                    } else {
                        const item = document.createElement('div');
                        item.className = 'spec-item';

                        const label = document.createElement('span');
                        label.className = 'spec-label';
                        label.textContent = `${key}:`;

                        const val = document.createElement('span');
                        val.className = 'spec-value';
                        val.textContent = value;

                        item.appendChild(label);
                        item.appendChild(val);
                        content.appendChild(item);
                    }
                }

                modal.style.display = 'block';
                icon.src = 'media/Spec_active.svg';
                isVisible = true;
            } catch (err) {
                content.innerHTML = '<p>Error loading specs.</p>';
                modal.style.display = 'block';
                icon.src = 'media/Spec_active.svg';
                isVisible = true;
                console.error(err);
            }

            // Close checklist if it's open
            const checklist = document.getElementById('checklist-container');
            if (checklist) {
                checklist.style.display = 'none';
            }

            document.getElementById('specModal').style.display = 'block';
            icon.src = 'media/Spec_active.svg';
        };

        const hideSpecs = () => {
            modal.style.display = 'none';
            icon.src = 'media/Spec_default.svg';
            isVisible = false;
        };

        button.addEventListener('click', () => {
            if (isVisible) {
                hideSpecs();
            } else {
                showSpecs();
            }
        });

        closeIcon.addEventListener('click', hideSpecs);

        button.addEventListener('mouseenter', () => {
            if (!isVisible) icon.src = 'media/Spec_active.svg';
        });

        button.addEventListener('mouseleave', () => {
            if (!isVisible) icon.src = 'media/Spec_default.svg';
        });
    }

    animate() {
        // Disable shadow and tone mapping on mobile for performance

        // Pause rendering when page is hidden
        if (document.hidden) return;
        requestAnimationFrame(this.animate.bind(this));
        this.controls.update();

        // Only update hotspot positions if camera or controls changed
        if (this.cameraChanged || this.controlsChanged) {
            this.updateHotspotPositions();
            this.cameraChanged = false;
            this.controlsChanged = false;
        }

        // Update animations
        if (this.mixer) {
            const delta = this.clock.getDelta();
            this.mixer.update(delta);
        }

        //Render using composer (postprocessing effects) if not mobile
        // if (!IS_MOBILE && this.composer) {
        //     this.composer.render();
        // } else {
        //     this.renderer.render(this.scene, this.camera);
        // }
        //this.renderer.render(this.scene, this.camera);
        this.composer.render();
        this.stats.update();
    }

    animateOutlineEdgeStrength(start, end, duration, onComplete) {
        if (!this.outlineEffect) return;
        const startTime = performance.now();
        const animate = () => {
            const now = performance.now();
            const t = Math.min((now - startTime) / duration, 1);
            this.outlineEffect.edgeStrength = start + (end - start) * t;
            if (t < 1) {
                requestAnimationFrame(animate);
            } else {
                this.outlineEffect.edgeStrength = end;
                if (onComplete) onComplete();
            }
        };
        animate();
    }
}

// Initialize the application
new HotspotManager();
