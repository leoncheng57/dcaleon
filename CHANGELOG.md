# Changelog

## [0.2.0](https://github.com/leoncheng57/dcaleon/compare/v0.1.1...v0.2.0) (2026-09-09)


### ⚠ BREAKING CHANGES

* **claude:** remove the Seatbelt sandbox from Claude sessions

### Features

* add mobile-first design component library and live gallery ([4cd4929](https://github.com/leoncheng57/dcaleon/commit/4cd4929f91d9fb340a69c374f7f52009823c1a54))
* add runtime picker as the front page ([#407](https://github.com/leoncheng57/dcaleon/issues/407)) ([31f30e1](https://github.com/leoncheng57/dcaleon/commit/31f30e17c423e4477e22fe52f3390374c44caba1))
* **browser:** mark session browser beta ([58277a0](https://github.com/leoncheng57/dcaleon/commit/58277a0ee1ae8af2ea10a4950fe7e7a506cee485))
* **browser:** mark session browser beta ([edcd064](https://github.com/leoncheng57/dcaleon/commit/edcd064ea40c2afe5bdabdf4ac2c62b805a4a04b))
* **claude:** add a terminal-parity sandbox mode ([#487](https://github.com/leoncheng57/dcaleon/issues/487)) ([cee96d3](https://github.com/leoncheng57/dcaleon/commit/cee96d3a6ca79ebe4e15cf7e77f63a3c9bb2978c))
* **claude:** add Claude Code local-binary runtime as a third island ([#341](https://github.com/leoncheng57/dcaleon/issues/341)) ([7e82a25](https://github.com/leoncheng57/dcaleon/commit/7e82a25d41e527c5aa397f72e2331fe8c5619588))
* **claude:** add mobile composer collapse and coarse-pointer Enter policy ([#482](https://github.com/leoncheng57/dcaleon/issues/482)) ([be90b61](https://github.com/leoncheng57/dcaleon/commit/be90b6120e5333048b0a7b99524e176f227ecc47))
* **claude:** grant whole-disk read in the session Seatbelt profile ([#491](https://github.com/leoncheng57/dcaleon/issues/491)) ([d80ec36](https://github.com/leoncheng57/dcaleon/commit/d80ec36bdb3323e6349e4e6382e7895609907673))
* **claude:** route permission checks to the user instead of pre-approving them ([#493](https://github.com/leoncheng57/dcaleon/issues/493)) ([f0b6e94](https://github.com/leoncheng57/dcaleon/commit/f0b6e942467496939f8a4bd072eeb4deef60d110)), closes [#488](https://github.com/leoncheng57/dcaleon/issues/488)
* **claude:** surface gated approvals, name stalls, and label each response's model ([6b475be](https://github.com/leoncheng57/dcaleon/commit/6b475be6157718c8c1b35c1c4e6058bd8fd8d91b))
* **claude:** surface gated approvals, name stalls, and label each response's model ([06434bc](https://github.com/leoncheng57/dcaleon/commit/06434bc12acad23ef048630c0a519fc4dbade481))
* **claude:** wire auto permissions into the Claude approval gate ([03c49fd](https://github.com/leoncheng57/dcaleon/commit/03c49fd2bbd6cea0d70d28f2de8cedf6fbd4ff96))
* **claude:** wire auto permissions into the Claude approval gate ([f047198](https://github.com/leoncheng57/dcaleon/commit/f04719866e2dcbd1b234c3d14e27b4bed3ce9e4a))
* **deploy:** add a callable supervised deploy script ([#489](https://github.com/leoncheng57/dcaleon/issues/489)) ([1960509](https://github.com/leoncheng57/dcaleon/commit/1960509dc1b62071ec4687614bd150c0cedeecc1))
* manual session rename across all three runtime islands ([3d1b2a8](https://github.com/leoncheng57/dcaleon/commit/3d1b2a8599abf4e03a8a7ddca1f214242c79cfc0))
* manual session rename across all three runtime islands ([c8be389](https://github.com/leoncheng57/dcaleon/commit/c8be3896f6d128895980910226ade632f7134ffe)), closes [#120](https://github.com/leoncheng57/dcaleon/issues/120)
* mobile-first design component library and live gallery ([794f9c0](https://github.com/leoncheng57/dcaleon/commit/794f9c0c9c19ccb863e2b0913acc8710b6fa149a))
* open transcript web links in the shared session browser ([2871935](https://github.com/leoncheng57/dcaleon/commit/28719357bf69d86c4f1dea7d77b656418713af54))
* **playbooks:** document reminders at 1:1 with workflows ([#336](https://github.com/leoncheng57/dcaleon/issues/336)) ([095398f](https://github.com/leoncheng57/dcaleon/commit/095398f1aaab0c7a82bcb6e1b71bf8a6a8eb9334))
* **playbooks:** give every workflow and reminder a worked example ([#340](https://github.com/leoncheng57/dcaleon/issues/340)) ([d6119bf](https://github.com/leoncheng57/dcaleon/commit/d6119bfe88db6be2bec12693f70108ba7fe7e6b7))
* **reminders:** add the Brink Nudge Learning playbook ([#450](https://github.com/leoncheng57/dcaleon/issues/450)) ([8645ba7](https://github.com/leoncheng57/dcaleon/commit/8645ba7f2640f5170a912cfcadb0a1c9c9b33c6e)), closes [#447](https://github.com/leoncheng57/dcaleon/issues/447)
* **resources:** add CPU and memory monitor beside session usage ([#457](https://github.com/leoncheng57/dcaleon/issues/457)) ([762dc1e](https://github.com/leoncheng57/dcaleon/commit/762dc1e4d3546d00d8a93b1b87abf1a7e1cfad05))
* set Opus 4.6 as the default model for all islands ([79800ca](https://github.com/leoncheng57/dcaleon/commit/79800cac4b0f393695a4f3f516657bd0e92ef558)), closes [#500](https://github.com/leoncheng57/dcaleon/issues/500)
* share right tools panel across all runtime islands ([ada08ec](https://github.com/leoncheng57/dcaleon/commit/ada08ec78ce5c95241f01d66de0c3e049893a995))
* ship a Codex-quality live browser right panel ([5d1420b](https://github.com/leoncheng57/dcaleon/commit/5d1420bd712dceefd7db14276c19ac9128b25ceb))
* ship a polished live browser right tools panel ([93cfe34](https://github.com/leoncheng57/dcaleon/commit/93cfe3403873ee75034a8e3c9c8a0ef0bd1258c0))
* surface Claude Code project memory ([#426](https://github.com/leoncheng57/dcaleon/issues/426)) ([eddaf47](https://github.com/leoncheng57/dcaleon/commit/eddaf477898e560a02c9b0717c2118e333add517))
* **transcript:** show per-message cost and latency ([#455](https://github.com/leoncheng57/dcaleon/issues/455)) ([573a2ce](https://github.com/leoncheng57/dcaleon/commit/573a2ce509f86e294a3ffab7d44c2f1478787cc3))
* **transcript:** unify cross-runtime message metrics ([#460](https://github.com/leoncheng57/dcaleon/issues/460)) ([69051a2](https://github.com/leoncheng57/dcaleon/commit/69051a20a3b9869423e2e65d1a7981e10af75e62))
* unify OpenCode and DSH session UI with shared components ([#414](https://github.com/leoncheng57/dcaleon/issues/414)) ([566f21b](https://github.com/leoncheng57/dcaleon/commit/566f21b8d9e9dbd1b8add7e70a0c17535029e142))
* unify Playwright PR screenshot review and publication ([#430](https://github.com/leoncheng57/dcaleon/issues/430)) ([9d7e83e](https://github.com/leoncheng57/dcaleon/commit/9d7e83ee7c0330cb891dd84372396f4d4c296434))
* **workflows:** retire the command catalogue for generic-argument workflows ([#338](https://github.com/leoncheng57/dcaleon/issues/338)) ([699f928](https://github.com/leoncheng57/dcaleon/commit/699f9285dbc127aa76d037a62e8ac2f5d2e37847))


### Bug Fixes

* **claude:** allow pgrep inside the Seatbelt sandbox ([#494](https://github.com/leoncheng57/dcaleon/issues/494)) ([3d83fbc](https://github.com/leoncheng57/dcaleon/commit/3d83fbce93d6ba03df9fbed95097cc467f48e3f9))
* **claude:** allow pgrep inside the Seatbelt sandbox ([#494](https://github.com/leoncheng57/dcaleon/issues/494)) ([#494](https://github.com/leoncheng57/dcaleon/issues/494)) ([dfcf032](https://github.com/leoncheng57/dcaleon/commit/dfcf0327fabcf3fec9e7df47f8e330d99985eb66))
* **claude:** anchor the usage popover to the trigger's left edge ([#422](https://github.com/leoncheng57/dcaleon/issues/422)) ([4163ed1](https://github.com/leoncheng57/dcaleon/commit/4163ed1918c4f3a4ee20acd4babd38b898c4e18c)), closes [#421](https://github.com/leoncheng57/dcaleon/issues/421)
* **claude:** bound transcript data and virtualize history ([#461](https://github.com/leoncheng57/dcaleon/issues/461)) ([2c09fbe](https://github.com/leoncheng57/dcaleon/commit/2c09fbe40d44914a161afb497e8be18d8162c74e))
* **claude:** bound transcript rendering and skip unchanged refreshes ([#456](https://github.com/leoncheng57/dcaleon/issues/456)) ([0988ce1](https://github.com/leoncheng57/dcaleon/commit/0988ce1e78022f1ec525a9a3a96fcd0bcb1ed275))
* **claude:** carry a project's local env files into its worktree ([24e3000](https://github.com/leoncheng57/dcaleon/commit/24e30007f40a7aca22ccdedb28978c5c49c261a9))
* **claude:** carry a project's local env files into its worktree ([36e80ba](https://github.com/leoncheng57/dcaleon/commit/36e80ba3025731dd11f41d27e20ff04175a65999))
* **claude:** dynamic tab titles and notification running status ([4bf2978](https://github.com/leoncheng57/dcaleon/commit/4bf297883085b21198baf97e6d2d99d93db9d80d))
* **claude:** dynamic tab titles and notification running status for Claude sessions ([d0f9be7](https://github.com/leoncheng57/dcaleon/commit/d0f9be70e37082f56d24a32edf4ab329afc32ff9)), closes [#505](https://github.com/leoncheng57/dcaleon/issues/505)
* **claude:** fix usage popover accounting, error resilience, and freshness ([b1d9e15](https://github.com/leoncheng57/dcaleon/commit/b1d9e15a89cb8284fabf21b8e5da5959f50ef118))
* **claude:** fix usage popover accounting, error resilience, and freshness ([4cf835a](https://github.com/leoncheng57/dcaleon/commit/4cf835a7df94fe05e8e5c0e20e4c682aa7379138))
* **claude:** harden island session execution ([#477](https://github.com/leoncheng57/dcaleon/issues/477)) ([516a20b](https://github.com/leoncheng57/dcaleon/commit/516a20b14bd7381644eb035c16fb81c8357e9fb6))
* **claude:** let a session verify its own work ([#490](https://github.com/leoncheng57/dcaleon/issues/490)) ([0030473](https://github.com/leoncheng57/dcaleon/commit/0030473981ae6a1a35f73c01aeec43b52e90b406))
* **claude:** recover visibly from interrupted turns ([#481](https://github.com/leoncheng57/dcaleon/issues/481)) ([1d98faa](https://github.com/leoncheng57/dcaleon/commit/1d98faa28fd488ac3cdfac75744bf21aeed4a237))
* **claude:** replace in-place agent event mutations so transcript index detects changes ([#485](https://github.com/leoncheng57/dcaleon/issues/485)) ([48538ac](https://github.com/leoncheng57/dcaleon/commit/48538ac998c16bfd02dafc16ee741fc5f453e74e)), closes [#484](https://github.com/leoncheng57/dcaleon/issues/484)
* **claude:** scope approval retries by session; wrap approval actions on phones ([62b6e3b](https://github.com/leoncheng57/dcaleon/commit/62b6e3b35290ca2db8e6c2527794689b4a0b7fec))
* **claude:** support composer image attachments ([#428](https://github.com/leoncheng57/dcaleon/issues/428)) ([1c2dc74](https://github.com/leoncheng57/dcaleon/commit/1c2dc74d5818c4885831aae7e31c081a71f1005c))
* **claude:** support multiple queued follow-ups ([#458](https://github.com/leoncheng57/dcaleon/issues/458)) ([3158ff9](https://github.com/leoncheng57/dcaleon/commit/3158ff90aa08774d4f7aad6cfe92aaf5670418ba))
* **deploy:** detect bootstrap success from service state ([fa2f3ab](https://github.com/leoncheng57/dcaleon/commit/fa2f3abcc85b936e7924db5391edf05ce8efc595))
* **deploy:** detect bootstrap-error-5 success from service state, not exit code ([9499702](https://github.com/leoncheng57/dcaleon/commit/9499702d5a227550c8603d74ec808f5cbffbbd34)), closes [#498](https://github.com/leoncheng57/dcaleon/issues/498)
* **deploy:** retry transient launchd bootstrap failures ([#492](https://github.com/leoncheng57/dcaleon/issues/492)) ([1fdbdcc](https://github.com/leoncheng57/dcaleon/commit/1fdbdccfc94c22fd218f82b349ffbc68b082f75b))
* **dsh:** clean up redundant model preset option text ([#406](https://github.com/leoncheng57/dcaleon/issues/406)) ([01e271a](https://github.com/leoncheng57/dcaleon/commit/01e271ad98f9ff38c3303fa1429be70f4575aea3))
* guard OpenCode rename with the same cross-directory ownership check as share ([4c4ca7e](https://github.com/leoncheng57/dcaleon/commit/4c4ca7e05e986c0b76e7fdf60628c5c94d26fe5a))
* keep mobile browser opener clear of runtime usage stats ([c9897f2](https://github.com/leoncheng57/dcaleon/commit/c9897f2abcba28698f666b91771ab9a69e9773cc))
* **notifications:** publish local DSH build completions ([#439](https://github.com/leoncheng57/dcaleon/issues/439)) ([805a1c2](https://github.com/leoncheng57/dcaleon/commit/805a1c2a6dc92a0916f22733bea798bdd570b1d9))
* **notifications:** record why a push provider refused delivery ([#465](https://github.com/leoncheng57/dcaleon/issues/465)) ([b49b4b2](https://github.com/leoncheng57/dcaleon/commit/b49b4b206704999ee21522945da85619ad8f2e5f))
* **notifications:** refresh subscription before PWA test push ([#476](https://github.com/leoncheng57/dcaleon/issues/476)) ([042a804](https://github.com/leoncheng57/dcaleon/commit/042a804dc30f0326302e3f65310faef77f694636))
* **notifications:** suppress no-op auto-approval restore audit entries ([758f3e0](https://github.com/leoncheng57/dcaleon/commit/758f3e0c11b35b6edc3b13baf3d8bb4dd90548aa))
* **notifications:** suppress no-op auto-approval restore audit entries ([897bb5c](https://github.com/leoncheng57/dcaleon/commit/897bb5c3e0bdc9900d73aaf002a7825018a82f72)), closes [#470](https://github.com/leoncheng57/dcaleon/issues/470)
* preserve inspector space beneath tall session banners ([fb0ab8f](https://github.com/leoncheng57/dcaleon/commit/fb0ab8f93c1b541a5e60abc1cf84271856d81e29))
* preserve right panel space beside tall session banners ([b148cac](https://github.com/leoncheng57/dcaleon/commit/b148caccd957c16123265ef06de50311eeeecd4e))
* re-subscribe when a device's push key is superseded ([#464](https://github.com/leoncheng57/dcaleon/issues/464)) ([3165e0d](https://github.com/leoncheng57/dcaleon/commit/3165e0db2723758b02c87055d0c7fb095ddc26a1))
* render first browser navigation and static stream frames ([93fa319](https://github.com/leoncheng57/dcaleon/commit/93fa31946b086beb5faed828149502c33469f879))
* **screenshots:** pair every capturable route with its wait target ([#404](https://github.com/leoncheng57/dcaleon/issues/404)) ([bf1f556](https://github.com/leoncheng57/dcaleon/commit/bf1f556586f6074f9f72bb72198d3e128dc7f97f))
* **ui:** distinguish no-directory from loading in model picker ([f0bb817](https://github.com/leoncheng57/dcaleon/commit/f0bb817f7e4d161aebacfaefb334e92be30a0bd3))
* **ui:** distinguish no-directory from loading in model picker ([e814320](https://github.com/leoncheng57/dcaleon/commit/e8143209bb887cc435c3f26ae333b9989cba3c7b)), closes [#479](https://github.com/leoncheng57/dcaleon/issues/479)
* **ui:** give blocking questions their own scrollport beneath the banners ([f9ba379](https://github.com/leoncheng57/dcaleon/commit/f9ba379f619cdd14f77719a7fc32e0e3f64e36ef))
* **ui:** keep banners and prompts inside the existing 25% region ([fdcb6ee](https://github.com/leoncheng57/dcaleon/commit/fdcb6ee51f961e9d24d4ac6d3c9115751292687b))
* **ui:** let the banners wrapper be the sole scrollport for the question ([b672ab0](https://github.com/leoncheng57/dcaleon/commit/b672ab0b36c2a08ce8cb0170b0035f7089664a0c))
* **ui:** make question Submit/Reject buttons always reachable ([55a992e](https://github.com/leoncheng57/dcaleon/commit/55a992e76545ee7ab4bd6596c6f44d7abeed2651))
* **ui:** make question Submit/Reject buttons always reachable ([068ed87](https://github.com/leoncheng57/dcaleon/commit/068ed871dafb5cb0103c1c8f1040991e6fc3b79a)), closes [#508](https://github.com/leoncheng57/dcaleon/issues/508)
* usage popover — normalize utilization, warn on unavailable limits ([8c3733b](https://github.com/leoncheng57/dcaleon/commit/8c3733b6a34420239416a1c69b1d5a70a8af8509)), closes [#502](https://github.com/leoncheng57/dcaleon/issues/502)


### Code Refactoring

* **claude:** remove the Seatbelt sandbox from Claude sessions ([bd2a408](https://github.com/leoncheng57/dcaleon/commit/bd2a408d1397f3495dbba1933447efa6f0154cab))

## [0.1.1](https://github.com/leoncheng57/dcaleon/compare/v0.1.0...v0.1.1) (2026-08-30)


### Features

* **app:** add release version visibility ([a1680a0](https://github.com/leoncheng57/dcaleon/commit/a1680a0509790361046afc7d885356bdad836f94))
* **app:** add semantic versioning and build visibility ([d0499bc](https://github.com/leoncheng57/dcaleon/commit/d0499bceb2c8b6fdd9b7a18fb756702f5b8e11c7))


### Bug Fixes

* **app:** preserve navbar alignment and patch releases ([c2c73d6](https://github.com/leoncheng57/dcaleon/commit/c2c73d677f0492253f0a58ecb643872bf5138fee))
* **app:** preserve navbar alignment and patch releases ([03d4746](https://github.com/leoncheng57/dcaleon/commit/03d4746e7c648f73782ef4cf86f9eaebb81f6db3))
