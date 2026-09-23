# Bit distribution: first full attestor cycle

Block 71381515 (2026-09-23T08:02:52.136Z). 3876 Ignix launches, 38 graduated, 10 agent-linked.
Read-only against X Layer mainnet; bits posted to a **local fork** LatchFeed (chain id 1960), filters evaluated there.

## Per bit

| bit | name | source | set | share |
|---|---|---|---|---|
| 0 | AGENT_LINKED | attested | 10 | 0.3% |
| 1 | REV_GE_100 | attested | 0 | 0.0% |
| 2 | REV_GE_1000 | attested | 0 | 0.0% |
| 3 | LP_LOCKED | attested | 38 | 1.0% |
| 4 | TOP10_LT_40 | attested | 22 | 0.6% |
| 5 | TOP10_LT_25 | attested | 10 | 0.3% |
| 6 | DEV_NO_SELL_7D | attested | 3725 | 96.1% |
| 7 | LATCH_LOCKED | on-chain | 0 | 0.0% |
| 8 | AGE_GE_7D | on-chain | 2038 | 52.6% |
| 9 | AGE_GE_30D | on-chain | 189 | 4.9% |
| 10 | HOLDERS_GE_100 | attested | 31 | 0.8% |
| 11 | HOLDERS_GE_300 | attested | 14 | 0.4% |
| 12 | LP_PULLED | attested | 0 | 0.0% |

Top-10 share of circulating supply: p10 100%, median 100%, p90 100%.
Holder counts vs Ignix API: 3876/3876 within ±5 (our count excludes curve, pools, lockers, protocol, burn).

## Most common attested bit combinations

| launches | bits |
|---|---|
| 3691 | DEV_NO_SELL_7D |
| 139 | (none) |
| 10 | LP_LOCKED DEV_NO_SELL_7D |
| 5 | AGENT_LINKED DEV_NO_SELL_7D |
| 3 | LP_LOCKED DEV_NO_SELL_7D HOLDERS_GE_100 |
| 3 | LP_LOCKED TOP10_LT_40 HOLDERS_GE_100 HOLDERS_GE_300 |
| 3 | LP_LOCKED TOP10_LT_40 TOP10_LT_25 DEV_NO_SELL_7D HOLDERS_GE_100 HOLDERS_GE_300 |
| 3 | LP_LOCKED TOP10_LT_40 DEV_NO_SELL_7D HOLDERS_GE_100 |
| 2 | LP_LOCKED TOP10_LT_40 TOP10_LT_25 HOLDERS_GE_100 HOLDERS_GE_300 |
| 2 | LP_LOCKED TOP10_LT_40 TOP10_LT_25 DEV_NO_SELL_7D HOLDERS_GE_100 |

## Starter filters (evaluated through LatchGate on the fork)

| filter | kind | pass | share |
|---|---|---|---|
| BASIC_SAFETY | combinational | 12 | 0.3% |
| REVENUE_AGENTS | combinational | 0 | 0.0% |
| STICKY_SAFETY | latch | 13 | 0.3% |
| STRICT | combinational | 0 | 0.0% |
| UNLOCK_T1 | combinational | 24 | 0.6% |
| UNLOCK_T2 | combinational | 0 | 0.0% |

## Launches with any signal (graduated, agent-linked, or ≥100 holders): 46

| token | holders | top-10 | LP | dev sold 7d | agent | passes |
|---|---|---|---|---|---|---|
| `0x87359b7d78b03bd81b567bf425263b453c73eeee` | 3965 | 64.2% | locked (v2) |  |  | UNLOCK_T1 |
| `0xa8198d9bca089f99a0eb016c0462f7278001eeee` | 2666 | 12.9% | locked (v2) |  |  | BASIC_SAFETY, STICKY_SAFETY, UNLOCK_T1 |
| `0x0c9535416fd3b772646c4575e0664fd65afeeeee` | 2533 | 18.8% | locked (v2) |  |  | BASIC_SAFETY, STICKY_SAFETY, UNLOCK_T1 |
| `0x0933f674bcfec78bd0f4720faf370fd9709feeee` | 2193 | 86.7% | locked (v2) | yes |  | UNLOCK_T1 |
| `0x2026a3fcb9f2d2317085ab59bd666b64dd81eeee` | 2144 | 12.6% | locked (v2) |  | $0 | BASIC_SAFETY, STICKY_SAFETY, UNLOCK_T1 |
| `0x16aa672dda63f5acd0de098c04c4a3e957d1eeee` | 1903 | 16.4% | locked (v2) | yes |  |  |
| `0xa63e42d09bfca311e8091269ac45fdeba9b0eeee` | 1282 | 33.0% | locked (v2) | yes |  | UNLOCK_T1 |
| `0x6a9559dbff4b46d7997cd7177127d817e76beeee` | 1016 | 25.4% | locked (v2) | yes |  | UNLOCK_T1 |
| `0xcb98ad437e96c16000b124c30338dd59b367eeee` | 974 | 27.0% | locked (v2) |  |  | BASIC_SAFETY, STICKY_SAFETY, UNLOCK_T1 |
| `0x7cda817043f9c53490bcbdf06b05feaa8e8beeee` | 709 | 28.7% | locked (v2) |  |  | BASIC_SAFETY, STICKY_SAFETY, UNLOCK_T1 |
| `0x0f8a6683a166444254d304871af443cb84c6eeee` | 700 | 9.8% | locked (v2) |  |  | BASIC_SAFETY, STICKY_SAFETY, UNLOCK_T1 |
| `0x783cadb32c3cf34ba3eed907b519f1b27ef9eeee` | 435 | 22.2% | locked (v2) |  | $11.5 | BASIC_SAFETY, STICKY_SAFETY, UNLOCK_T1 |
| `0x93473df78414d36d98962ef60ef2e4c94650eeee` | 423 | 21.3% | locked (v2) | yes |  | UNLOCK_T1 |
| `0x381bcca21e3d2e069fb2ba44569c1054cc62eeee` | 319 | 27.8% | locked (v2) | yes |  | UNLOCK_T1 |
| `0xf3c02ec2d17c9bcad4b3ae38d6a2f4b5d4b5bbbb` | 271 | 25.6% | locked (v4) |  |  | BASIC_SAFETY, STICKY_SAFETY, UNLOCK_T1 |
| `0x4b54acf3b4f5642be2a734f4dc3f71661ee9eeee` | 258 | 39.4% | locked (v2) |  |  | BASIC_SAFETY, STICKY_SAFETY, UNLOCK_T1 |
| `0xe74ebb791b4c433dfe4305f0f4adf1df5f77eeee` | 255 | 15.9% | locked (v2) |  |  | BASIC_SAFETY, STICKY_SAFETY, UNLOCK_T1 |
| `0x789cbcf6992fca13abeeeb55d7a3466dbaf6eeee` | 251 | 27.9% | locked (v2) | yes | $0.03002 |  |
| `0x21d6359cab338ea54705e7d04efbaadd9020eeee` | 247 | 13.4% | locked (v2) |  |  | BASIC_SAFETY, STICKY_SAFETY |
| `0x6c54dd1187bf84b7ed9f786e9eb5d25f0d9beeee` | 242 | 25.8% | locked (v2) | yes |  | UNLOCK_T1 |
| `0xf93de4ef61309ca8bcd0feab0c6f4dd9b2c4eeee` | 238 | 32.7% | locked (v2) |  |  | BASIC_SAFETY, STICKY_SAFETY, UNLOCK_T1 |
| `0xf29749c1ebc20f860cc9159d0a6ca26df97deeee` | 210 | 24.0% | locked (v2) | yes |  | UNLOCK_T1 |
| `0x83bda39bc8e9f05751d5a7caae4049146cedeeee` | 188 | 38.3% | curve |  | $0 | STICKY_SAFETY |
| `0x544dd87d8e91c108bc2c088c4d2b649c4eefeeee` | 175 | 48.9% | curve |  |  |  |
| `0xb77d57b65b67b45c89b9626eeeece90adc8ceeee` | 168 | 26.0% | locked (v2) | yes | $0 | UNLOCK_T1 |
| `0xf41bb89a39830a88cdc963fb0e91e24ce74ceeee` | 143 | 100.0% | locked (v2) |  |  | UNLOCK_T1 |
| `0x32cefdc856adf33362f31a7a8fe61c8aefc7eeee` | 114 | 53.1% | locked (v2) |  |  | UNLOCK_T1 |
| `0x4d1019fbae8dcbeb73e22c21512e26b87cdaeeee` | 112 | 48.3% | locked (v2) | yes |  |  |
| `0x77584b2805a204f56c4b250a6c8d314c713abbbb` | 106 | 40.5% | locked (v4) |  |  | UNLOCK_T1 |
| `0xb7c5294db2c6af012138fe7a045b62a1c0faeeee` | 103 | 41.5% | locked (v2) | yes |  | UNLOCK_T1 |
| `0x2b93a765dce5cc352af74b56c888f1bf0063eeee` | 103 | 47.5% | curve |  |  |  |
| `0x2f7fd7a078e59c676a8099c4c4775a3b0549bbbb` | 79 | 56.0% | locked (v4) |  |  |  |
| `0xcbb9bd17490b71843c16610b2f8e21a9c5d4eeee` | 77 | 57.0% | locked (v2) |  |  |  |
| `0x995546dfdf93bef59c35742ab5f4762fbcb8eeee` | 50 | 60.5% | curve |  | $0 |  |
| `0xbb9a906f1a8906d548c5d94b7079fa31bf09eeee` | 46 | 80.5% | locked (v2) |  |  |  |
| `0xac2a03492dee554e6d2f3d48a8f0c8db7866eeee` | 42 | 69.3% | curve |  | $0 |  |
| `0x3a75e725dce841adfaeda829ca8700c14d91eeee` | 34 | 78.3% | locked (v2) |  |  |  |
| `0x3a77d4e76b6496428f4b92a83d64f6605d5deeee` | 32 | 60.1% | curve |  | $8.80013 |  |
| `0x82ea4dda1185d8ecaa92ad13d9a205778f87eeee` | 32 | 87.4% | locked (v2) |  |  |  |
| `0xb899567d73ed11b0234926735ac8eb8b6668eeee` | 20 | 100.0% | locked (v2) |  |  |  |
| `0x7ceea33f02694892dfa066cdaa9494fa1fa7eeee` | 17 | 99.9% | locked (v2) |  |  |  |
| `0x79fc48150c666a7f643ac1bb6a1c64dd9f5aeeee` | 15 | 97.5% | curve |  | $0 |  |
| `0xd949ea91c4581bc33a136b69f21d0e871587eeee` | 13 | 99.4% | curve |  | $0 |  |
| `0xfcf9a6de16db771ceac989c9c1528b48a500eeee` | 11 | 100.0% | locked (v2) |  |  |  |
| `0x64f495a29ea8af9161f57550df4df9dc289feeee` | 8 | 100.0% | locked (v2) |  |  |  |
| `0xe97e35cef8e0f7513e01e54fe17e857e1ae0bbbb` | 8 | 100.0% | locked (v4) |  |  |  |
