/**
 * Contract ABIs as human-readable signatures, parsed by viem's parseAbi into
 * the structured ABI objects wagmi/viem hooks require for full type inference.
 * These match the deployed Solidity contracts exactly.
 */

import { parseAbi } from 'viem';

export const marketFactoryAbi = parseAbi([
  'function createMarket(string question, string category, uint256 resolutionTime, address resolver, uint256 fee) returns (uint256 questionId, address fpmm)',
  'function resolveMarket(uint256 questionId, uint256[2] payouts)',
  'function markets(uint256) view returns (address fpmm, bytes32 conditionId, string question, string category, uint256 resolutionTime, address resolver, bool resolved)',
  'function nextQuestionId() view returns (uint256)',
  'function owner() view returns (address)',
  'function collateralToken() view returns (address)',
  'function conditionalTokens() view returns (address)',
  'function paused() view returns (bool)',
  'event MarketCreated(uint256 indexed questionId, address indexed fpmm, bytes32 indexed conditionId, string question, string category, uint256 resolutionTime, address resolver, uint256 fee)',
  'event MarketResolved(uint256 indexed questionId, uint256[2] payouts)',
]);

export const fpmmAbi = parseAbi([
  'function calcBuyAmount(uint256 outcome, uint256 investmentAmount) view returns (uint256)',
  'function calcSellAmount(uint256 outcome, uint256 returnAmount) view returns (uint256)',
  'function buy(uint256 outcome, uint256 investmentAmount, uint256 minSharesOut) returns (uint256 sharesOut)',
  'function sell(uint256 outcome, uint256 returnAmount, uint256 maxSharesIn) returns (uint256 sharesIn)',
  'function addLiquidity(uint256 amount, uint256 minShares) returns (uint256 shares)',
  'function removeLiquidity(uint256 shares, uint256 minCollateral) returns (uint256 collateral)',
  'function reserves() view returns (uint256 yes, uint256 no)',
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function yesPositionId() view returns (uint256)',
  'function noPositionId() view returns (uint256)',
  'function fee() view returns (uint256)',
  'function conditionId() view returns (bytes32)',
  // Trade/liquidity events. These are the source of truth for price history:
  // replaying them from the pool's creation block reconstructs reserves at
  // every block, which is what the probability chart is derived from.
  'event Buy(address indexed buyer, uint256 outcome, uint256 investmentAmount, uint256 sharesOut)',
  'event Sell(address indexed seller, uint256 outcome, uint256 returnAmount, uint256 sharesIn)',
  'event LiquidityAdded(address indexed provider, uint256 collateral, uint256 shares)',
  'event LiquidityRemoved(address indexed provider, uint256 shares, uint256 collateral)',
]);

export const conditionalTokensAbi = parseAbi([
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'function setApprovalForAll(address operator, bool approved)',
  'function isApprovedForAll(address account, address operator) view returns (bool)',
  'function redeemPositions(address collateral, bytes32 conditionId)',
  'function getPositionId(address collateral, bytes32 conditionId, uint256 outcome) view returns (uint256)',
  'function getPayouts(bytes32 conditionId) view returns (bool resolved, uint256[2] numerators, uint256 denominator)',
]);

export const erc20Abi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function faucet()',
]);
