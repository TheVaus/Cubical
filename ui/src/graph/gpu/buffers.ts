export interface GrowableBuffer {
  buffer: GPUBuffer;
  capacity: number;
}

export function createGrowable(
  device: GPUDevice,
  byteLength: number,
  usage: GPUBufferUsageFlags,
  label: string,
): GrowableBuffer {
  const capacity = Math.max(16, align(byteLength));
  return {
    buffer: device.createBuffer({ label, size: capacity, usage }),
    capacity,
  };
}

export function align(byteLength: number): number {
  return Math.ceil(Math.max(byteLength, 1) / 4) * 4;
}

export function upload(
  device: GPUDevice,
  target: GrowableBuffer,
  data: Float32Array | Uint32Array,
  usage: GPUBufferUsageFlags,
  label: string,
): GrowableBuffer {
  const needed = align(data.byteLength);
  let out = target;
  if (needed > target.capacity) {
    target.buffer.destroy();
    out = createGrowable(device, growTo(needed), usage, label);
  }
  if (data.length > 0) {
    device.queue.writeBuffer(out.buffer, 0, data);
  }
  return out;
}

export function growTo(needed: number): number {
  let capacity = 16;
  while (capacity < needed) capacity *= 2;
  return capacity;
}
