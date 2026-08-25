export interface Installation {
  id: string;
  name: string;
  address: string;
}

export type TabKind = "desktop" | "apphub";

export interface TabInfo {
  id: string;
  installationId: string;
  installationName: string;
  kind: TabKind;
  parentId: string | null;
  title: string;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
