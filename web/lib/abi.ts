import { parseAbi } from 'viem';

export const gateAbi = parseAbi([
  'function filterCount() view returns (uint256)',
  'function getFilter(uint256) view returns ((address cpu, uint64 circuitId, uint32 gateCount, uint32 nState, address netlistPointer, bytes32 netlistHash, address registrant, string name))',
  'function check(address token, uint256 filterId) view returns (bool pass, uint16 inputs)',
  'function checkMany(address[] tokens, uint256 filterId) view returns (bool[] passes, uint16[] ins)',
  'function checkLocal(address token, uint256 filterId) view returns (bool pass, uint16 inputs)',
  'function inputs(address token) view returns (uint16)',
  'function registerFilter(address cpu, uint256 circuitId, string name, bytes32 expectedHash) returns (uint256)',
  'event FilterRegistered(uint256 indexed filterId, address indexed cpu, uint256 indexed circuitId, string name, uint32 gateCount, uint32 nState, bytes32 netlistHash, address registrant)',
  'event Unlatched(address indexed token, uint256 indexed filterId, uint16 inputs)',
  'event Latched(address indexed token, uint256 indexed filterId, uint16 inputs)',
]);

export const lockAbi = parseAbi([
  'function feeBps() view returns (uint16)',
  'function minLockBps() view returns (uint16)',
  'function treasury() view returns (address)',
  'function lockCount() view returns (uint256)',
  'function createLock(address token, uint256 amount, address beneficiary, (uint64 filterId, uint16 bps)[] tranches) returns (uint256)',
  'function release(uint256 lockId, uint256 trancheIdx) returns (uint256)',
  'function locksByBeneficiary(address) view returns (uint256[])',
  'function locksByToken(address) view returns (uint256[])',
  'function getLock(uint256) view returns ((address token, address depositor, address beneficiary, uint64 createdAt, uint256 amount, uint256 released), (uint64 filterId, uint16 bps, bool released, uint256 amount)[])',
  'event FeeCharged(uint256 indexed lockId, address indexed token, address indexed treasury, uint256 fee)',
  'event LockCreated(uint256 indexed lockId, address indexed token, address indexed beneficiary, address depositor, uint256 received, uint256 locked)',
]);

export const feedAbi = parseAbi([
  'function isFresh() view returns (bool)',
  'function lastHeartbeat() view returns (uint64)',
  'function maxAge() view returns (uint64)',
]);

export const erc20Abi = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address, address) view returns (uint256)',
  'function approve(address, uint256) returns (bool)',
]);

export const processorAbi = parseAbi([
  'function transistors() view returns (address)',
  'function TAPEOUT_FEE() view returns (uint256)',
  'function tapeout(bytes nl, uint32 nIn, uint32 nOut) payable returns (uint256)',
  'event TapedOut(uint256 indexed circuitId, address indexed author, uint32 gateCount, uint32 nState)',
]);

export const transistorsAbi = parseAbi([
  'function mint(uint256 id, uint256 amount) payable',
  'function mintPrice() view returns (uint256)',
  'function protocolFee() view returns (uint256)',
  'function supplyCap() view returns (uint256)',
  'function minted() view returns (uint256)',
  'function balanceOf(address, uint256) view returns (uint256)',
]);
