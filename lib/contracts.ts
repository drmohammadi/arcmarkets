/**
 * Contract addresses by chain, read from deployment artifacts.
 * The contracts deploy script merges into deployments/index.json, keyed by chainId.
 */

import { Address } from 'viem';
import deploymentsData from './deployments/index.json';

export interface Deployment {
  chainId: number;
  network: string;
  collateralToken: Address;
  isMockUSDC: boolean;
  conditionalTokens: Address;
  marketFactory: Address;
  deployer: Address;
}

const deployments = deploymentsData as Record<string, Deployment>;

/**
 * Get deployment addresses for the given chain ID.
 * Returns null if not deployed or deployment entry is missing.
 */
export function getDeployment(chainId: number): Deployment | null {
  return deployments[String(chainId)] ?? null;
}

/**
 * All available deployments (testnet, local, eventually mainnet).
 */
export function getAllDeployments(): Deployment[] {
  return Object.values(deployments);
}
