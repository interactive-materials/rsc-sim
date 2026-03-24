import * as THREE from "https://cdn.esm.sh/three@0.139.0";
import { STLExporter } from "https://cdn.esm.sh/three@0.139.0/examples/jsm/exporters/STLExporter.js?deps=three@0.139.0";
import { GPUComputationRenderer } from "./GPUComputationRenderer.js";
import Stats from "./Stats.js";

let rotationZ = +localStorage.getItem("rotationZ");
if (!rotationZ) {
  rotationZ = 0.0;
} else if (isNaN(rotationZ)) {
  rotationZ = 0.0;
}

let rotationX = +localStorage.getItem("rotationX");
if (!rotationX) {
  rotationX = Math.PI * 0.3;
} else if (isNaN(rotationX)) {
  rotationX = Math.PI * 0.3;
}

let scaleModel = +localStorage.getItem("scaleModel");
if (!scaleModel) {
  scaleModel = 1.0;
} else if (isNaN(scaleModel)) {
  scaleModel = 1.0;
}

console.log(scaleModel, rotationZ, rotationX);

const rotationXMax = 2.0 * Math.PI;
const rotationXMin = -2.0 * Math.PI;
const scaleMin = 0.5;
const scaleMax = 10.0;
const scaleFactor = 0.05;

let isComputing = false;
let isTexDisplay = false;
let simulationTime = 0;
let simulationTimelapse = 0;
let simulationTimestamp = -1;
let tScale = 1.0;

const heightScale = 0.04;
const cellSpacing = 0.05;

const absorptionRatePlaster = 0.12;
const absorptionRateClay = 0.08;
const diffusion = 0.1;
const diffusionGravity = 0.12;
const depositionRate = 0.4;
const depositionRateGravity = 0.6;
const depositionThreshold = 0.2;
const depositionThresholdGravity = 0.1;
const averaging = 0.015;
const heightSmoothingThreshold = 1.0 * heightScale;

let clayColor = 0xdadad0;
let plasterColor = 0xf0f0f0;

const storedClayColor = localStorage.getItem("clayColor");
const storedPlasterColor = localStorage.getItem("plasterColor");
if (storedClayColor) {
  clayColor = parseInt(storedClayColor, 16);
  document.querySelector("#clay-color-input").value = storedClayColor;
}
if (storedPlasterColor) {
  plasterColor = parseInt(storedPlasterColor, 16);
  document.querySelector("#plaster-color-input").value = storedPlasterColor;
}

let mobileCheck = false;
if (navigator.maxTouchPoints > 1 && window.innerWidth < 700) {
  mobileCheck = true;
}

// Grid size
const sizeX = mobileCheck ? 250 : 500,
  sizeY = mobileCheck ? 250 : 500,
  sizeZ = mobileCheck ? 35 : 64;

// Initialize Three.js renderer

const totalSize = sizeX * sizeY * sizeZ;
const texWidth = Math.ceil(Math.pow(totalSize, 0.5));
const texHeight = Math.ceil(totalSize / texWidth);

const canvas = document.createElement("canvas");
const ctx = canvas.getContext("2d");
canvas.width = sizeX;
canvas.height = sizeY;

console.log(`totalSize: ${totalSize}`);
console.log(`width: ${texWidth}`);
console.log(`height: ${texHeight}`);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  28,
  window.innerWidth / window.innerHeight,
  1,
  1000
);
camera.position.z = 50;
scene.add(camera);

const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

scene.add(new THREE.HemisphereLight(0xffffff, 0x000000, 0.8));

var dlight = new THREE.DirectionalLight(0xffffff, 0.5);


// override light position

dlight.position.set(20, 0, 5.0);
dlight.target.position.set(0, 0, 0);

scene.add(dlight);


//
//
//
//
//  COMPUTE SHADER
//
//
//
//
//

// GPUComputationRenderer

let gpuCompute;

// Create initial state texture

const maskData = [];

for (let x = 0; x < sizeX; x++) {
  maskData.push([]);
  for (let y = 0; y < sizeY; y++) {
    if (x % (sizeX * 0.1) < sizeX * 0.05 && y % (sizeY * 0.1) < sizeY * 0.05) {
      maskData[x].push(0.0);
    } else {
      maskData[x].push(1.0);
    }
  }
}

const simFragmentShader = `
uniform sampler2D u_gridState;
uniform vec2 res;
uniform int sx;
uniform int sy;
uniform int sz;

void main() {
  // Compute texture coordinates from fragment position
  vec2 uv = gl_FragCoord.xy / res;
  ivec2 texSize = ivec2(res);
  ivec2 pos = ivec2(gl_FragCoord.xy);
  int idx = pos.x + texSize.x * pos.y;
  int pz = idx % sz;
  int py = (idx / sz) % sy;
  int px = idx / (sy * sz);

  float log1 = 0.0;
  float log2 = 0.0;
  float log3 = 0.0;

  if (idx >= sx * sy * sz) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);

  } else {
    // gl_FragColor = vec4(float(pz) / float(sz), 0.0, 0.0, 1.0);

    float water = texelFetch(u_gridState, ivec2(idx % texSize.x, idx / texSize.x), 0).b;
    float clay = texelFetch(u_gridState, ivec2(idx % texSize.x, idx / texSize.x), 0).r;

    float waterGradient = 0.0;
    float clayAccumulation = 0.0;

    float absorptionRatePlaster = ${absorptionRatePlaster};
    float absorptionRateClay = ${absorptionRateClay};
    float depositionRate = ${depositionRate};
    float depositionRateGravity = ${depositionRateGravity};
    float depositionThreshold = ${depositionThreshold};
    float depositionThresholdGravity = ${depositionThresholdGravity};
    float diffusion = ${diffusion};
    float diffusionGravity = ${diffusionGravity};
    float averaging = ${averaging};

    if (pz < sz - 1 && pz > 0) {

      // Neighbor offsets
      ivec3 neighbors[6] =
          ivec3[](ivec3(-1, 0, 0), ivec3(1, 0, 0), ivec3(0, -1, 0),
                  ivec3(0, 1, 0), ivec3(0, 0, 1), ivec3(0, 0, -1)
                  );

      for (int i = 0; i < 6; i++) {
        ivec3 npos = ivec3(px, py, pz) + neighbors[i];

        // Boundary check
        if (npos.x >= 0 && npos.x < sx && npos.y >= 0 && npos.y < sy &&
            npos.z >= 0 && npos.z < sz) {

          // Calculate the 1D index for the neighbor
          int nidx_1d = npos.z + (npos.y + npos.x * sy) * sz;

          float vWater = texelFetch(u_gridState, ivec2(nidx_1d % texSize.x, nidx_1d / texSize.x), 0).b;
          float vClay = texelFetch(u_gridState, ivec2(nidx_1d % texSize.x, nidx_1d / texSize.x), 0).r;
          float dw = 0.0;
          float dr = i >= 5 ? depositionRateGravity : depositionRate;
          float dThreshold = i >= 5 ? depositionThresholdGravity : depositionThreshold;

          if (npos.z == 0) {
            dw = absorptionRatePlaster * vWater;
            waterGradient -= dw;
            clayAccumulation += dw * dr;
          } else {
            dw = water - vWater;
            if (dw > 0.0 && clay < 1.0 && vClay >= dThreshold) {
              waterGradient += absorptionRateClay * -dw;
              clayAccumulation += dw * dr;
            } else {
              float diff = i >= 5 ? diffusionGravity : diffusion;
              waterGradient += diff * -dw;
            }
          }
        }
      }

      // Neighbor offsets
      ivec3 neighbors2[8] =
          ivec3[](ivec3(-1, -1, -1), ivec3(0, -1, -1), ivec3(1, -1, -1),
                  ivec3(-1, 0, -1), ivec3(1, 0, -1),
                  ivec3(-1, 1, -1), ivec3(0, 1, -1), ivec3(1, 1, -1)
                  );

      for (int i = 0; i < 8; i++) {
        ivec3 npos = ivec3(px, py, pz) + neighbors2[i];

        // Calculate the 1D index for the neighbor
        int nidx_1d = npos.z + (npos.y + npos.x * sy) * sz;

        if (npos.z > 1) {
          // Boundary check
          if (npos.x >= 0 && npos.x < sx && npos.y >= 0 && npos.y < sy && npos.z < sz) {
            float vClay = texelFetch(u_gridState, ivec2(nidx_1d % texSize.x, nidx_1d / texSize.x), 0).r;
            float dClay = vClay - clay;
            if (dClay < 0.0) {
              clayAccumulation += averaging * dClay;
            }
          }
        }
      }


      // Neighbor offsets
      ivec3 neighbors3[8] =
          ivec3[](ivec3(-1, -1, 1), ivec3(0, -1, 1), ivec3(1, -1, 1),
                  ivec3(-1, 0, 1), ivec3(1, 0, 1),
                  ivec3(-1, 1, 1), ivec3(0, 1, 1), ivec3(1, 1, 1)
                  );

      for (int i = 0; i < 8; i++) {
        ivec3 npos = ivec3(px, py, pz) + neighbors3[i];

        // Calculate the 1D index for the neighbor
        int nidx_1d = npos.z + (npos.y + npos.x * sy) * sz;

        if (npos.z < sz - 1) {
          // Boundary check
          if (npos.x >= 0 && npos.x < sx && npos.y >= 0 && npos.y < sy && npos.z > 0) {
            float vClay = texelFetch(u_gridState, ivec2(nidx_1d % texSize.x, nidx_1d / texSize.x), 0).r;
            float dClay = vClay - clay;
            if (dClay > 0.0) {
              clayAccumulation += averaging * dClay;
            }
          }
        }
      }


      clay += clayAccumulation;
      water += waterGradient;

      clay = clamp(clay, 0.0, 1.0);
      water = clamp(water, 0.0, 1.0);
    }

    float totalHeight = 0.0;

    if (idx < sx * sy) {
      int sumpx = idx % sx;
      int sumpy = idx / sx;
      int sumpz = 0;
      int sumidx_1d = 0;
      for (int i = 1; i < sz; i++) {
        sumpz = i;
        sumidx_1d = sumpz + (sumpy + sumpx * sy) * sz;
        float h = texelFetch(u_gridState, ivec2(sumidx_1d % texSize.x, sumidx_1d / texSize.x), 0).r;
        totalHeight += h;
      }
    }

    if (pz == 0 || pz == sz - 1) {
      gl_FragColor = vec4(0.0, totalHeight, water, 1.0);
    } else {
      gl_FragColor = vec4(clay, totalHeight, water, 1.0);
    }
  }
}
`;

let gridVariable;

function resetComputeShader(imgdata) {
  gpuCompute = new GPUComputationRenderer(texWidth, texHeight, renderer);

  const initialTexture = gpuCompute.createTexture();
  const initData = initialTexture.image.data;

  // Reset the data (e.g., setting all values to 0)
  for (let ty = 0; ty < texHeight; ty++) {
    for (let tx = 0; tx < texWidth; tx++) {
      const i = tx + ty * texWidth;
      const x = Math.floor(i / (sizeY * sizeZ));
      const y = Math.floor(i / sizeZ) % sizeY;
      const z = Math.floor(i % sizeZ);

      if (i < totalSize) {
        if (z === 0) {
          initData[i * 4 + 0] = 0.0;
          initData[i * 4 + 1] = 0.0;
          initData[i * 4 + 2] = imgdata[x][y];
          initData[i * 4 + 3] = 1.0;
        } else {
          initData[i * 4 + 0] = 0.0;
          initData[i * 4 + 1] = 0.0;
          initData[i * 4 + 2] = 1.0;
          initData[i * 4 + 3] = 0.0;
        }
      } else {
        initData[i * 4 + 0] = 0.0;
        initData[i * 4 + 1] = 0.0;
        initData[i * 4 + 2] = 0.0;
        initData[i * 4 + 3] = 0.0;
      }
    }
  }

  gridVariable = gpuCompute.addVariable(
    "gridState",
    simFragmentShader,
    initialTexture
  );

  // Pass resolution as a uniform (updated to 'res')
  gpuCompute.setVariableDependencies(gridVariable, [gridVariable]);
  gridVariable.material.uniforms.res = {
    value: new THREE.Vector2(texWidth, texHeight), // Updated to 'res'
  };
  gridVariable.material.uniforms.sx = {
    value: sizeX,
  };
  gridVariable.material.uniforms.sy = {
    value: sizeY,
  };
  gridVariable.material.uniforms.sz = {
    value: sizeZ,
  };

  simulationTime = 0;
  simulationTimelapse = 0;
  simulationTimestamp = -1;

  gpuCompute.init();
  gpuCompute.compute();
}

resetComputeShader(maskData);

//
//
//
//
//  GEOMETRY / MESH
//
//
//
//
//

const width = sizeX,
  height = sizeY,
  spacing = cellSpacing;
const vertices = new Float32Array(width * height * 3);
const indices = new Uint32Array((width - 1) * (height - 1) * 6);

let vIdx = 0,
  iIdx = 0;
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    vertices[vIdx++] = x * spacing - (width * spacing) / 2;
    vertices[vIdx++] = y * spacing - (height * spacing) / 2;
    vertices[vIdx++] = 0;

    if (x < width - 1 && y < height - 1) {
      const i0 = y * width + x;
      const i1 = y * width + (x + 1);
      const i2 = (y + 1) * width + x;
      const i3 = (y + 1) * width + (x + 1);
      indices[iIdx++] = i0;
      indices[iIdx++] = i2;
      indices[iIdx++] = i1;
      indices[iIdx++] = i1;
      indices[iIdx++] = i2;
      indices[iIdx++] = i3;
    }
  }
}

const geometry = new THREE.BufferGeometry();
geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
geometry.setIndex(new THREE.BufferAttribute(indices, 1));
geometry.computeVertexNormals();

const uvs = new Float32Array(width * height * 2);
let uvIdx = 0;
for (let x = 0; x < width; x++) {
  for (let y = 0; y < height; y++) {
    uvs[uvIdx++] = x / (width - 1);
    uvs[uvIdx++] = y / (height - 1);
  }
}
geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));

let materialMode = "matte"; // matte, contour, normal

const materialMatte = new THREE.MeshPhongMaterial({
  color: clayColor,
  side: THREE.DoubleSide,
  wireframe: false,
});

const materialMatteTransparent = new THREE.MeshPhongMaterial({
  color: clayColor,
  side: THREE.DoubleSide,
  transparent: true,
  opacity: 0.8,
  wireframe: false,
});


const materialContour = new THREE.ShaderMaterial({
  uniforms: {
    heightMap: {
      value: gpuCompute.getCurrentRenderTarget(gridVariable).texture,
    },
    res: {
      value: new THREE.Vector2(width, height),
    },
    sx: {
      value: sizeX,
    },
    sy: {
      value: sizeY,
    },
    sz: {
      value: sizeZ,
    },
    tx: {
      value: texWidth,
    },
    ty: {
      value: texHeight,
    },
  },
  side: THREE.DoubleSide,
  vertexShader: `
      varying vec2 vUv;
      varying float vZ; // Pass the Z value to the fragment shader
      uniform vec2 res;
      uniform sampler2D heightMap; // The texture from GPUComputationRenderer
      uniform int sx;
      uniform int sy;
      uniform int sz;
      uniform int tx;
      uniform int ty;

      void main() {
          vUv = uv; // Pass UVs to fragment shader if needed
          vec2 pos = uv * res;
          int px = int(pos.x);
          int py = int(pos.y);

          int idx = py + px * sy;

          float height = texelFetch(heightMap, ivec2(idx % tx, idx / tx), 0).g; // Sample height from the texture

          vec3 newPosition = position + height * -0.1; // // Modify vertex position and scale height
          vZ = newPosition.z; // Pass Z value to the fragment shader

          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
  fragmentShader: `
      varying vec2 vUv; // Receive UV coordinates from the vertex shader
      varying float vZ; // Receive the Z value from the vertex shader

      void main() {
          float red = vUv.x;  // Red increases from left to right
          float green = vUv.y; // Green increases from bottom to top
          // float blue = abs((mod(vZ * 2.0, 1.0) - 0.5) * 2.0);
          // blue = 1.0 - blue * blue;
          float blue = mod(vZ * 4.0, 1.0) * 0.85;
          blue = 0.9 - blue * blue * blue;

          gl_FragColor = vec4(blue, blue, blue, 1.0); // RGBA output
      }
    `,
});

const materialNormal = new THREE.ShaderMaterial({
  side: THREE.DoubleSide,
  vertexShader: `
    varying vec3 vNormal;
  
    void main() {
        // 1. Transform the normal into View Space (Eye Space)
        // The normalMatrix is the inverse transpose of the ModelViewMatrix
        // We normalize it to ensure the length is 1.0 after transformation.
        vNormal = normalize(normalMatrix * normal);
  
        // 2. Standard vertex position calculation
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    // fragmentShader
    varying vec3 vNormal;

    void main() {
        // The vNormal components are in the range [-1.0, 1.0].
        // We need to map this range to the color range [0.0, 1.0] for R, G, B.
        // The formula for remapping is: (Value + 1.0) * 0.5

        vec3 color = vNormal;

        // Map X to Red (R)
        float r = abs(color.x);

        // Map Y to Green (G)
        float g = abs(color.y);

        // Map Z to Blue (B)
        float b = abs(color.z);

        gl_FragColor = vec4(r, g, b, 1.0);
    }
  `,
  // Ensure the normals are calculated correctly even when scaling the mesh
  lights: false,
  uniforms: {},
});

// Apply the material to your mesh
const mesh = new THREE.Mesh(geometry, materialMatte);
mesh.receiveShadow = true;
scene.add(mesh);

let baseTexture = new THREE.Texture(canvas);

const baseMaterialMap = new THREE.MeshBasicMaterial({
  color: plasterColor,
  map: baseTexture,
  side: THREE.DoubleSide,
  wireframe: false,
});
baseTexture.needsUpdate = true;

const baseMaterial = new THREE.MeshBasicMaterial({
  color: plasterColor,
  side: THREE.DoubleSide,
  wireframe: false,
});

const baseMaterialTransparent = new THREE.MeshPhongMaterial({
  color: clayColor,
  side: THREE.DoubleSide,
  transparent: true,
  opacity: 0.0,
  wireframe: false,
});

const baseGeometry = new THREE.PlaneGeometry(
  sizeX * cellSpacing,
  sizeY * cellSpacing
);
const baseMesh = new THREE.Mesh(baseGeometry, baseMaterial);
baseMesh.position.set(0, 0, 0.01);
scene.add(baseMesh);

//
//
//
//
//  RENDER COMPUTATION
//
//
//
//
//

// Create a plane to display the texture
const textureMaterial = new THREE.MeshBasicMaterial({
  map: gpuCompute.getCurrentRenderTarget(gridVariable).texture,
  side: THREE.DoubleSide,
});

const textureGeometry = new THREE.PlaneGeometry(0.01, 0.01);
const textureMesh = new THREE.Mesh(textureGeometry, textureMaterial);
textureMesh.position.set(0, 0, -20);
scene.add(textureMesh);

function updateComputeTexture() {
  const renderTarget = gpuCompute.getCurrentRenderTarget(gridVariable);
  const heightMapTexture = renderTarget.texture;
  textureMaterial.map = heightMapTexture;
  textureMaterial.needsUpdate = true;

  modifyMesh(renderTarget);
}

updateComputeTexture();

//
//
//
//
//  ANIMATE LOOP
//
//
//
//
//

// Animation loop
let frameCount = 0;
let modifyFrame = 1;
let animateMesh = true;


// Animation loop
const stats = new Stats()
// the number will decide which information will be displayed
// 0 => FPS Frames rendered in the last second. The higher the number the better.
// 1 => MS Milliseconds needed to render a frame. The lower the number the better.
// 2 => MB MBytes of allocated memory. (Run Chrome with --enable-precise-memory-info)
// 3 => CUSTOM User-defined panel support.
stats.showPanel(0);
// document.body.appendChild(stats.dom);
stats.dom.style.removeProperty("left");
stats.dom.style.right = "0px";

function animate() {
  stats.begin();
  requestAnimationFrame(animate);

  if (isComputing) {
    gpuCompute.compute();

    // Get the updated texture
    const renderTarget = gpuCompute.getCurrentRenderTarget(gridVariable);
    const heightMapTexture = renderTarget.texture;
    textureMaterial.map = heightMapTexture;
    textureMaterial.needsUpdate = true;

    frameCount = (frameCount + 1) % modifyFrame;
    if (frameCount === 0) {
      materialContour.uniforms.heightMap.value = heightMapTexture;
      materialContour.needsUpdate = true;
      materialNormal.needsUpdate = true;
      modifyMesh(renderTarget);
    }
  }

  if (animateMesh) {
    mesh.rotation.x = -rotationX;
    baseMesh.rotation.x = -rotationX;

    mesh.rotation.z = rotationZ;
    baseMesh.rotation.z = rotationZ;

    mesh.scale.set(scaleModel, scaleModel, scaleModel);
    baseMesh.scale.set(scaleModel, scaleModel, scaleModel);

    renderer.render(scene, camera);
  }
  stats.end();
}

function modifyMesh(_renderTarget, check) {
  // Read data from the texture for vertex displacement
  const sampleHeight = Math.ceil((sizeX * sizeY) / texWidth);
  const heightMap = new Float32Array(texWidth * sampleHeight * 4);
  renderer.readRenderTargetPixels(
    _renderTarget,
    0,
    0,
    texWidth,
    sampleHeight,
    heightMap
  );

  // Update geometry vertices
  const positionAttribute = geometry.attributes.position;
  for (let x = 0; x < sizeX; x++) {
    for (let y = 0; y < sizeY; y++) {
      const index = y + x * sizeY;
      const textureIndex = index * 4;
      const greenValue = heightMap[textureIndex + 1];

      tScale = 1.0;
      if (simulationTimestamp === -1 && isComputing) {
        simulationTimestamp = Date.now();
      } else if (isComputing) {
        simulationTimelapse = Date.now() - simulationTimestamp;
        tScale = 1 / (1 + Math.pow((simulationTime + simulationTimelapse) * 0.001 / 73.15, 2.05));
      }

      let tempHeight = greenValue * heightScale * tScale;

      positionAttribute.setZ(index, tempHeight);
    }
  }
  positionAttribute.needsUpdate = true;
  geometry.computeVertexNormals();
}

animate();

//
//
//
//
//  UI
//
//
//
//
//

let isMouseDown = false;

let mx, pmx, my, pmy;
let t1x, t1y, t2x, t2y;

window.addEventListener("mousedown", (e) => {
  isMouseDown = true;
});

window.addEventListener("mouseup", (e) => {
  isMouseDown = false;
});

window.addEventListener("wheel", (e) => {
  if (!isComputing) {
    if (e.deltaY < 0) {
      scaleModel *= 1 + scaleFactor;
    } else {
      scaleModel *= 1 - scaleFactor;
    }
    scaleModel = Math.min(scaleMax, Math.max(scaleModel, scaleMin));

    localStorage.setItem("scaleModel", scaleModel);
  } else {
    warning();
  }
});

document.querySelector("canvas").addEventListener("mousemove", (e) => {
  mx = +e.clientX;
  my = +e.clientY;

  if (pmx && pmy && !isComputing && isMouseDown) {
    const dx = mx - pmx;
    const dy = my - pmy;
    let flipZ = rotationX > Math.PI * 0.5 && rotationX < Math.PI * 1.5 ? -1 : 1;
    flipZ = my < window.innerHeight * 0.5 ? -flipZ : flipZ;
    rotationZ += dx * flipZ * 0.002;
    rotationX += -dy * 0.002;

    rotationX = rotationX < 0 ? rotationX + 2.0 * Math.PI : rotationX;
    rotationX = rotationX % (2.0 * Math.PI);

    localStorage.setItem("rotationX", rotationX);
    localStorage.setItem("rotationZ", rotationZ);
  } else if (isComputing && isMouseDown) {
    warning();
  }

  pmx = mx;
  pmy = my;
});

document.querySelector("canvas").addEventListener("touchmove", (e) => {
  e.preventDefault();

  if (e.touches.length == 2) {
    if (!isComputing) {
      const c1x = +e.touches[0].pageX;
      const c1y = +e.touches[0].pageY;
      const c2x = +e.touches[1].pageX;
      const c2y = +e.touches[1].pageY;

      const l1 = Math.pow(Math.pow(t1x - t2x, 2) + Math.pow(t1y - t2y, 2), 0.5);
      const l2 = Math.pow(Math.pow(c1x - c2x, 2) + Math.pow(c1y - c2y, 2), 0.5);

      const dl = (l2 - l1) * 0.003;
      scaleModel *= 1 + dl;

      scaleModel = Math.min(scaleMax, Math.max(scaleModel, scaleMin));

      localStorage.setItem("scaleModel", scaleModel);

      t1x = c1x;
      t1y = c1y;
      t2x = c2x;
      t2y = c2y;
    } else {
      warning();
    }
  } else if (e.touches.length == 1) {
    mx = +e.touches[0].pageX;
    my = +e.touches[0].pageY;

    if (pmx && pmy && !isComputing) {
      const dx = mx - pmx;
      const dy = my - pmy;
      rotationZ += dx * 0.002;
      rotationX += -dy * 0.001;

      rotationX =
        rotationX > rotationXMax
          ? rotationXMax
          : rotationX < rotationXMin
            ? rotationXMin
            : rotationX;

      localStorage.setItem("rotationX", rotationX);
      localStorage.setItem("rotationZ", rotationZ);
    } else if (isComputing) {
      warning();
    }

    pmx = mx;
    pmy = my;
  }
});

document.addEventListener("touchstart", (e) => {
  if (e.touches.length === 2) {
    t1x = e.touches[0].pageX;
    t1y = e.touches[0].pageY;
    t2x = e.touches[1].pageX;
    t2y = e.touches[1].pageY;
  }
});

document.addEventListener("touchend", (e) => {
  pmx = undefined;
  pmy = undefined;
  t1x = undefined;
  t1y = undefined;
  t2x = undefined;
  t2y = undefined;
});

document.addEventListener("touchcancel", (e) => {
  pmx = undefined;
  pmy = undefined;
  t1x = undefined;
  t1y = undefined;
  t2x = undefined;
  t2y = undefined;
});

function warning() {
  document.querySelector("#modal").classList.add("active");
  setTimeout(() => {
    document.querySelector("#modal").classList.remove("active");
  }, 1000);
}

function runFixedTime(t) {
  if (!isComputing) {
    startSim();
    setTimeout(() => {
      stopSim();
    }, t);
  }
}

window.addEventListener("keyup", (e) => {
  switch (e.key) {
    case " ":
      if (isComputing) {
        stopSim();
      } else {
        startSim();
      }
      break;
    case "r":
      resetComputeShader(maskData);
      updateComputeTexture();
      break;
    case "t":
      runFixedTime(1000);
      break;
    case "1":
      runFixedTime(25000);
      break;
    case "2":
      runFixedTime(55000);
      break;
    case "c":
      console.log(simulationTime + simulationTimelapse);
      break;
  }
});

document.querySelector("#controls-header").addEventListener("click", (e) => {
  document.querySelector("#controls").classList.toggle("active");
});

document.querySelector("#sim-on-btn").addEventListener("click", (e) => {
  if (isComputing) {
    stopSim();
  } else {
    startSim();
  }
});

document.querySelector("#sim-off-btn").addEventListener("click", (e) => {
  if (isComputing) {
    stopSim();
  } else {
    startSim();
  }
});

function startSim() {
  isComputing = true;
  console.log(`Computing: ${isComputing}`);
  document.querySelector("#sim-on-btn").classList.add("active");
  document.querySelector("#sim-off-btn").classList.remove("active");
}

function stopSim() {
  simulationTimestamp = -1;
  simulationTime += simulationTimelapse;
  simulationTimelapse = 0;
  isComputing = false;
  console.log(`Computing: ${isComputing}`);
  document.querySelector("#sim-off-btn").classList.add("active");
  document.querySelector("#sim-on-btn").classList.remove("active");
}

document.querySelector("#cs-show-btn").addEventListener("click", (e) => {
  if (isTexDisplay) {
    hideCS();
  } else {
    showCS();
  }
});

document.querySelector("#cs-hide-btn").addEventListener("click", (e) => {
  if (isTexDisplay) {
    hideCS();
  } else {
    showCS();
  }
});

function showCS() {
  isTexDisplay = true;
  textureMesh.scale.set(1000, 1000, 1000);
  textureMesh.position.set(0, 0, 10);
  document.querySelector("#cs-show-btn").classList.add("active");
  document.querySelector("#cs-hide-btn").classList.remove("active");
}

function hideCS() {
  isTexDisplay = false;
  textureMesh.scale.set(1, 1, 1);
  textureMesh.position.set(0, 0, -50);
  document.querySelector("#cs-hide-btn").classList.add("active");
  document.querySelector("#cs-show-btn").classList.remove("active");
}

document.querySelector("#reset-btn").addEventListener("click", (e) => {
  resetComputeShader(maskData);
  updateComputeTexture();
});

document.querySelector("#invert-btn").addEventListener("click", (e) => {
  invertMask();
  createPlaceholderImage();
  resetComputeShader(maskData);
  updateComputeTexture();
});

function invertMask() {
  for (let x = 0; x < sizeX; x++) {
    for (let y = 0; y < sizeY; y++) {
      maskData[x][y] = 1.0 - maskData[x][y];
    }
  }
}

function handleImageUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(e) {
    const img = document.getElementById("uploaded-image");
    img.src = e.target.result;
    analyzeImage(img);
  };
  reader.readAsDataURL(file);
}

document
  .querySelector("#file-input")
  .addEventListener("change", handleImageUpload);

function analyzeImage(image) {
  image.onload = function() {
    ctx.drawImage(image, 0, 0, sizeX, sizeY);
    baseTexture.needsUpdate = true;
    const imageData = ctx.getImageData(0, 0, sizeX, sizeY).data;

    let grayscaleArray = [];
    for (let x = 0; x < sizeX; x++) {
      for (let y = 0; y < sizeY; y++) {
        const index = ((sizeY - y - 1) * sizeY + x) * 4;
        const r = imageData[index];
        const g = imageData[index + 1];
        const b = imageData[index + 2];
        const gray = (r + g + b) / 3 / 255;
        maskData[x][y] = gray;
      }
    }
    resetComputeShader(maskData);
    updateComputeTexture();
  };
}

// Prepopulate with a blank white image
function createPlaceholderImage() {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, sizeX, sizeY);
  const imageData = ctx.getImageData(0, 0, sizeX, sizeY);
  for (let x = 0; x < sizeX; x++) {
    for (let y = 0; y < sizeY; y++) {
      const index = ((sizeY - y - 1) * sizeX + x) * 4;
      imageData.data[index] = Math.floor(255 * maskData[x][y]);
      imageData.data[index + 1] = Math.floor(255 * maskData[x][y]);
      imageData.data[index + 2] = Math.floor(255 * maskData[x][y]);
      imageData.data[index + 3] = 255;
    }
  }
  ctx.putImageData(imageData, 0, 0);

  document.getElementById("uploaded-image").src = canvas.toDataURL();
}

createPlaceholderImage();

function isHex(h) {
  var a = parseInt(h, 16);
  return a.toString(16).padStart(6, "0") === h.toLowerCase();
}

document.querySelector("#clay-color-input").addEventListener("change", (e) => {
  let val = e.target.value;
  if (isHex(val)) {
    mesh.material.color.setHex(`0x${val}`);
    materialMatte.color.setHex(`0x${val}`);
    materialMatteTransparent.color.setHex(`0x${val}`);
    localStorage.setItem("clayColor", val);
  }
});

document
  .querySelector("#plaster-color-input")
  .addEventListener("change", (e) => {
    let val = e.target.value;
    if (isHex(val)) {
      baseMesh.material.color.setHex(`0x${val}`);
      baseMaterial.color.setHex(`0x${val}`);
      localStorage.setItem("plasterColor", val);
    }
  });

document.querySelector("#material-toggle-btn").addEventListener("click", (e) => {
  toggleMaterial();
});

function toggleMaterial() {
  switch (materialMode) {
    case "matte":
      materialMode = "contour";
      break;
    case "contour":
      materialMode = "normal";
      break;
    case "normal":
      materialMode = "transparent";
      break;
    case "transparent":
      materialMode = "nobase";
      break;
    case "nobase":
      materialMode = "matte";
      break;
  }
  switch (materialMode) {
    case "matte":
      baseMesh.material = baseMaterial;
      mesh.material = materialMatte;
      mesh.needsUpdate = true;
      document.querySelector("#material-toggle-btn").innerHTML = "MATTE";
      break;
    case "transparent":
      baseMesh.material = baseMaterialMap;
      mesh.material = materialMatteTransparent;
      mesh.needsUpdate = true;
      document.querySelector("#material-toggle-btn").innerHTML = "MASK";
      break;
    case "contour":
      baseMesh.material = baseMaterial;
      mesh.material = materialContour;
      mesh.needsUpdate = true;
      document.querySelector("#material-toggle-btn").innerHTML = "CONTOUR";
      break;
    case "normal":
      baseMesh.material = baseMaterial;
      mesh.material = materialNormal;
      mesh.needsUpdate = true;
      document.querySelector("#material-toggle-btn").innerHTML = "NORMAL";
      break;
    case "nobase":
      baseMesh.material = baseMaterialTransparent;
      mesh.material = materialMatte;
      mesh.needsUpdate = true;
      document.querySelector("#material-toggle-btn").innerHTML = "NO BASE";
      break;
  }
}

document.querySelector("#export-stl").addEventListener("click", (e) => {
  exportSTL();
})

function exportSTL() {

  animateMesh = false;
  mesh.rotation.x = 0;
  baseMesh.rotation.x = 0;

  mesh.rotation.z = 0;
  baseMesh.rotation.z = 0;

  const exporter = new STLExporter();
  mesh.updateMatrixWorld(true);
  const stlString = exporter.parse(mesh);
  const blob = new Blob([stlString], { type: "application/sla" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "rsc-model.stl";
  link.click();
  URL.revokeObjectURL(url);

  animateMesh = true;
}
