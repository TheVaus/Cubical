import { EDGE_STRIDE_BYTES } from "./instances";

const SHADER = /* wgsl */ `
struct View {
  scale: vec2<f32>,
  centre: vec2<f32>,
  zoom: f32,
};

@group(0) @binding(0) var<uniform> view: View;

struct VsOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) colour: vec4<f32>,
};

fn corner(index: u32) -> vec2<f32> {
  var quad = array<vec2<f32>, 6>(
    vec2<f32>(0.0, -0.5), vec2<f32>(1.0, -0.5), vec2<f32>(0.0, 0.5),
    vec2<f32>(0.0, 0.5), vec2<f32>(1.0, -0.5), vec2<f32>(1.0, 0.5),
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
  @location(0) tail: vec2<f32>,
  @location(1) head: vec2<f32>,
  @location(2) rgba: u32,
  @location(3) flags: u32,
) -> VsOut {
  let local = corner(vertexIndex);
  let along = head - tail;
  let len = length(along);
  var dir = vec2<f32>(1.0, 0.0);
  if (len > 1e-6) {
    dir = along / len;
  }
  let normal = vec2<f32>(-dir.y, dir.x);
  let widthWorld = max(1.0 * view.zoom, 1.0) / view.zoom;
  let world = tail + dir * (local.x * len) + normal * (local.y * widthWorld);

  var out: VsOut;
  out.clip = vec4<f32>((world - view.centre) * view.scale, 0.0, 1.0);
  var colour = unpack(rgba);
  if ((flags & 1u) != 0u) {
    colour.a = colour.a * 0.08;
  }
  out.colour = colour;
  return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
  return vec4<f32>(in.colour.rgb * in.colour.a, in.colour.a);
}
`;

export function createEdgePass(
  device: GPUDevice,
  format: GPUTextureFormat,
): GPURenderPipeline {
  const module = device.createShaderModule({
    label: "graph-edge",
    code: SHADER,
  });
  return device.createRenderPipeline({
    label: "graph-edge",
    layout: "auto",
    vertex: {
      module,
      entryPoint: "vs",
      buffers: [
        {
          arrayStride: EDGE_STRIDE_BYTES,
          stepMode: "instance",
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x2" },
            { shaderLocation: 1, offset: 8, format: "float32x2" },
            { shaderLocation: 2, offset: 16, format: "uint32" },
            { shaderLocation: 3, offset: 20, format: "uint32" },
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
