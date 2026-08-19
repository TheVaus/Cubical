import type { GraphSnapshot } from "../api/ipc";
import {
  buildEdgeInstances,
  buildNodeInstances,
  degrees,
  edgeInstanceCount,
  readPalette,
} from "./gpu";
import { colourForFolder, folderOf, readFolderColours } from "./graphColor";
import type { Adjacency } from "./graphModel";
import { edgeFlags, nodeFlags } from "./hover";

export interface InstancePayload {
  nodes: ArrayBuffer;
  nodeCount: number;
  edges: ArrayBuffer;
  edgeCount: number;
}

export interface InstanceSource {
  build: (
    snapshot: GraphSnapshot,
    positions: Float32Array,
    adjacency: Adjacency,
    degree: Uint32Array,
    hovered: number | null,
    visible: Uint8Array,
  ) => InstancePayload;
  invalidateTheme: () => void;
}

export function createInstanceSource(host: Element): InstanceSource {
  let palette: ReturnType<typeof readPalette> | null = null;
  let folderColours: ReturnType<typeof readFolderColours> | null = null;

  return {
    invalidateTheme: () => {
      palette = null;
      folderColours = null;
    },
    build: (snapshot, positions, adjacency, degree, hovered, visible) => {
      if (palette === null || folderColours === null) {
        palette = readPalette(host);
        folderColours = readFolderColours(host);
      }
      const colours = new Uint32Array(snapshot.nodes.length);
      for (let i = 0; i < snapshot.nodes.length; i++) {
        const node = snapshot.nodes[i]!;
        colours[i] =
          node.kind === "note"
            ? colourForFolder(folderOf(node.key), folderColours)
            : palette[node.kind];
      }
      return {
        nodes: buildNodeInstances(
          snapshot.nodes,
          positions,
          degree,
          palette,
          nodeFlags(snapshot.nodes.length, adjacency, hovered, visible),
          colours,
        ),
        nodeCount: Math.min(
          snapshot.nodes.length,
          Math.floor(positions.length / 2),
        ),
        edges: buildEdgeInstances(
          snapshot.edges,
          positions,
          palette,
          edgeFlags(snapshot.edges, hovered, visible),
        ),
        edgeCount: edgeInstanceCount(snapshot.edges, positions),
      };
    },
  };
}

export function radiiFor(
  degree: Uint32Array,
  count: number,
  radiusFor: (d: number) => number,
): Float32Array {
  const radii = new Float32Array(count);
  for (let i = 0; i < count; i++) radii[i] = radiusFor(degree[i] ?? 0);
  return radii;
}

export { degrees };
