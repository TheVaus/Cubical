import { createContext } from "solid-js";

export type CanView = (path: string) => boolean;

export const cannotView: CanView = () => false;

export const CanViewContext = createContext<CanView>(cannotView);
