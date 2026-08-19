import { NODE_STRIDE_BYTES } from "./instances";

const SHADER = /* wgsl */ `
struct View {
  scale: vec2<f32>,
  centre: vec2<f32>,
  zoom: f32,
};

@group(0) @binding(0) var<uniform> view: View;

struct VsOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) local: vec2<f32>,
  @location(1) colour: vec4<f32>,
};

fn corner(index: u32) -> vec2<f32> {
  var quad = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
    vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
  );
  return quad[index];
}

fn unpack(rgba: u32) -> vec4<f32> {
  return vec4<f32>(
    f32((rgba >> 24u) & 255u) / 255.0,
    f32((rgba >> 16u) & 255u) / 255.0,
    f32((rgba >> 8u) & 255u) / 255.0,
    f32(rgba & 255u) / 255.0,
  );
}

@vertex
fn vs(
  @builtin(vertex_index) vertexIndex: u32,
  @location(0) centre: vec2<f32>,
  @location(1) radius: f32,
  @location(2) rgba: u32,
  @location(3) flags: u32,
) -> VsOut {
  let local = corner(vertexIndex);
  let screenRadius = max(radius * view.zoom, 1.5);
  let worldRadius = screenRadius / view.zoom;
  let world = centre + local * worldRadius;

  var out: VsOut;
  out.clip = vec4<f32>((world - view.centre) * view.scale, 0.0, 1.0);
  out.local = local;
  var colour = unpack(rgba);
  if ((flags & 1u) != 0u) {
    colour.a = colour.a * 0.15;
  }
  if ((flags & 2u) != 0u) {
    colour = vec4<f32>(min(colour.rgb * 1.4, vec3<f32>(1.0)), colour.a);
  }
  out.colour = colour;
  return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  let d = length(in.local);
  let edge = fwidth(d);
  let alpha = 1.0 - smoothstep(1.0 - edge, 1.0, d);
  if (alpha <= 0.0) {
    discard;
  }
  return vec4<f32>(in.colour.rgb * in.colour.a * alpha, in.colour.a * alpha);
}
`;

export function createNodePass(
  device: GPUDevice,
  format: GPUTextureFormat,
): GPURenderPipeline {
  const module = device.createShaderModule({
    label: "graph-node",
    code: SHADER,
  });
  return device.createRenderPipeline({
    label: "graph-node",
    layout: "auto",
    vertex: {
      module,
      entryPoint: "vs",
      buffers: [
        {
          arrayStride: NODE_STRIDE_BYTES,
          stepMode: "instance",
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x2" },
            { shaderLocation: 1, offset: 8, format: "float32" },
            { shaderLocation: 2, offset: 12, format: "uint32" },
            { shaderLocation: 3, offset: 16, format: "uint32" },
          ],
        },
      ],
    },
    fragment: {
      module,
      entryPoint: "fs",
      targets: [
        {
          format,
          blend: {
            color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
          },
        },
      ],
    },
    primitive: { topology: "triangle-list" },
  });
}
