import type { Camera, Viewport } from "../camera";
import { viewUniform } from "../camera";
import { createGrowable, upload, type GrowableBuffer } from "./buffers";
import { createEdgePass } from "./edgePass";
import type { GpuContext } from "./device";
import { createNodePass } from "./nodePass";

const VERTEX = GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST;
const UNIFORM = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;

export interface Renderer {
  setInstances: (
    nodes: ArrayBuffer,
    nodeCount: number,
    edges: ArrayBuffer,
    edgeCount: number,
  ) => void;
  draw: (camera: Camera, viewport: Viewport) => void;
  destroy: () => void;
}

export function createRenderer(gpu: GpuContext): Renderer {
  const { device, context, format } = gpu;

  const nodePipeline = createNodePass(device, format);
  const edgePipeline = createEdgePass(device, format);

  const uniform = device.createBuffer({
    label: "graph-view",
    size: 32,
    usage: UNIFORM,
  });

  const bind = (pipeline: GPURenderPipeline) =>
    device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uniform } }],
    });

  const nodeBind = bind(nodePipeline);
  const edgeBind = bind(edgePipeline);

  let nodeBuffer: GrowableBuffer = createGrowable(device, 16, VERTEX, "nodes");
  let edgeBuffer: GrowableBuffer = createGrowable(device, 16, VERTEX, "edges");
  let nodeCount = 0;
  let edgeCount = 0;

  const setInstances: Renderer["setInstances"] = (
    nodes,
    nodesLength,
    edges,
    edgesLength,
  ) => {
    nodeBuffer = upload(
      device,
      nodeBuffer,
      new Float32Array(nodes),
      VERTEX,
      "nodes",
    );
    edgeBuffer = upload(
      device,
      edgeBuffer,
      new Float32Array(edges),
      VERTEX,
      "edges",
    );
    nodeCount = nodesLength;
    edgeCount = edgesLength;
  };

  const draw: Renderer["draw"] = (camera, viewport) => {
    device.queue.writeBuffer(uniform, 0, viewUniform(camera, viewport));

    const encoder = device.createCommandEncoder({ label: "graph" });
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });

    if (edgeCount > 0) {
      pass.setPipeline(edgePipeline);
      pass.setBindGroup(0, edgeBind);
      pass.setVertexBuffer(0, edgeBuffer.buffer);
      pass.draw(6, edgeCount);
    }
    if (nodeCount > 0) {
      pass.setPipeline(nodePipeline);
      pass.setBindGroup(0, nodeBind);
      pass.setVertexBuffer(0, nodeBuffer.buffer);
      pass.draw(6, nodeCount);
    }

    pass.end();
    device.queue.submit([encoder.finish()]);
  };

  return {
    setInstances,
    draw,
    destroy: () => {
      nodeBuffer.buffer.destroy();
      edgeBuffer.buffer.destroy();
      uniform.destroy();
    },
  };
}
