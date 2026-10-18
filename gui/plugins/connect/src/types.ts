export type ConnectStateName = "disconnected" | "connected" | "reconnecting";

export interface ShareListing {
  hostId: string;
  hostName: string;
  port: number;
  createdAt: number;
  url: string;
  unavailableReason?: string;
}

export interface TunnelStatus {
  state: ConnectStateName;
  paired: boolean;
  handle: string | null;
  url: string | null;
  lastError: string | null;
  nextRetryAt: number | null;
  since: number;
  remoteClients: number;
  lastRemoteActivityAt: number | null;
  shares: ShareListing[];
}

export interface ConnectStatus extends TunnelStatus {
  signedIn: boolean;
}

export interface PhoneCode {
  code: string;
  expiresAt: number;
  url: string;
}

export const CONNECT_REALTIME_CHANNEL = "connect";

export const REMOTE_ACTIVITY_INSTRUCTIONS_MS = 5 * 60 * 1000;
