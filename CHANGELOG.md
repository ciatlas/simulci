# Changelog

## [0.5.0](https://github.com/ciatlas/simulci/compare/v0.4.0...v0.5.0) (2026-10-30)


### Features

* **cli:** remotes in plan and test, and simulci remotes ([#111](https://github.com/ciatlas/simulci/issues/111)) ([b354994](https://github.com/ciatlas/simulci/commit/b3549941d53553c827a3764e054aba7b8cbae61f))
* **docs:** the editorial landing ([#100](https://github.com/ciatlas/simulci/issues/100)) ([42759b4](https://github.com/ciatlas/simulci/commit/42759b430a06bf8be24a675af8d8ad0013fa7830))
* **engine:** check mocks against remote action interfaces ([#105](https://github.com/ciatlas/simulci/issues/105)) ([194e64e](https://github.com/ciatlas/simulci/commit/194e64ee291df3429536d58c25a1d164f2b368b8))
* **engine:** name reusable workflow calls in uses mocks ([#97](https://github.com/ciatlas/simulci/issues/97)) ([a91795e](https://github.com/ciatlas/simulci/commit/a91795e4e3e68f4b5bde2f8b7144401971978278))
* **engine:** simulate remote reusable workflows ([6364a0f](https://github.com/ciatlas/simulci/commit/6364a0f41a31adcf8dd1053471b8d88de9ea25fe))
* **engine:** the remotes lockfile ([#98](https://github.com/ciatlas/simulci/issues/98)) ([9faedac](https://github.com/ciatlas/simulci/commit/9faedacc1d0da130bf1bcc00ff0937c3c6788622))
* **node:** fetch, pin and cache remote sources ([#107](https://github.com/ciatlas/simulci/issues/107)) ([0cd81fd](https://github.com/ciatlas/simulci/commit/0cd81fd93b4cebe6376e8ec0f37e95e24eb174a4))
* **web:** a GitHub source that survives a reload ([17c1f64](https://github.com/ciatlas/simulci/commit/17c1f647fd7f78552e2c71063551ba4a52a4ae02))
* **web:** a way back to a closed panel ([#99](https://github.com/ciatlas/simulci/issues/99)) ([a2939fb](https://github.com/ciatlas/simulci/commit/a2939fba313a6c8682893ed8ad38280d8d25a7a5))
* **web:** fetch remote workflows and actions for the plan ([#109](https://github.com/ciatlas/simulci/issues/109)) ([1472abf](https://github.com/ciatlas/simulci/commit/1472abf42a4a53c75fd4f969aeeeb53c29af4027))
* **web:** learn the host's mode from /config.js ([#87](https://github.com/ciatlas/simulci/issues/87)) ([a21df54](https://github.com/ciatlas/simulci/commit/a21df54a5010b44f12315643f66e669821081013))
* **web:** open a public GitHub repository ([17c1f64](https://github.com/ciatlas/simulci/commit/17c1f647fd7f78552e2c71063551ba4a52a4ae02))
* **web:** run route tests in a Tests tab ([#92](https://github.com/ciatlas/simulci/issues/92)) ([8be745f](https://github.com/ciatlas/simulci/commit/8be745f2e2d303cd87567e9632b9b403ef3e5f89))


### Bug Fixes

* **document:** keep the comments of an emptied collection that are not its item's ([#96](https://github.com/ciatlas/simulci/issues/96)) ([d41bed5](https://github.com/ciatlas/simulci/commit/d41bed5aa4724d7f61338f3f257f891ef11dc805))
* **engine:** a fail-fast-cancelled leg's steps finish or not as its race says ([#93](https://github.com/ciatlas/simulci/issues/93)) ([c2251ea](https://github.com/ciatlas/simulci/commit/c2251ea9cbe00bc983a1b25c89cab6e2fa34e900))
* **engine:** read an unloaded reusable workflow's outputs as unknown ([#90](https://github.com/ciatlas/simulci/issues/90)) ([b124a66](https://github.com/ciatlas/simulci/commit/b124a66146418e8238527cf1c499533ba3139537))
* **web:** no CSP error when typing over a selection ([#88](https://github.com/ciatlas/simulci/issues/88)) ([2b2f166](https://github.com/ciatlas/simulci/commit/2b2f166e2ca71ad68c33cadcf779b6737d56d045))

## [0.4.0](https://github.com/ciatlas/simulci/compare/v0.3.0...v0.4.0) (2026-10-29)


### Features

* **docs:** the builder ([#85](https://github.com/ciatlas/simulci/issues/85)) ([42e75e1](https://github.com/ciatlas/simulci/commit/42e75e17e481ddef1b88cf931777ab7d29e0bbca))
* **document:** job and step operations ([ec04257](https://github.com/ciatlas/simulci/commit/ec04257d874ce2dc0f4cd61e63c33e64d75a5e5c))
* **document:** parse a workflow file and infer its style ([ec04257](https://github.com/ciatlas/simulci/commit/ec04257d874ce2dc0f4cd61e63c33e64d75a5e5c))
* **document:** render scalars and fragments in the file's style ([ec04257](https://github.com/ciatlas/simulci/commit/ec04257d874ce2dc0f4cd61e63c33e64d75a5e5c))
* **document:** splice primitives that keep the file's bytes ([ec04257](https://github.com/ciatlas/simulci/commit/ec04257d874ce2dc0f4cd61e63c33e64d75a5e5c))
* **document:** text edits and their inverses ([#49](https://github.com/ciatlas/simulci/issues/49)) ([5141127](https://github.com/ciatlas/simulci/commit/51411279d1939207f80cc81cfc7d270effbf70b0))
* **document:** trigger, matrix, test-case and rename operations ([#58](https://github.com/ciatlas/simulci/issues/58)) ([4f8d8d2](https://github.com/ciatlas/simulci/commit/4f8d8d2363c477dcbe90dd1b671f5d4032bfa9a8))
* **engine:** describe cron schedules ([#45](https://github.com/ciatlas/simulci/issues/45)) ([acbc771](https://github.com/ciatlas/simulci/commit/acbc7716e9f010d4d61e4ccbf05ea2adfa7d4719))
* **engine:** diff two plans of one scenario ([#47](https://github.com/ciatlas/simulci/issues/47)) ([7f0239e](https://github.com/ciatlas/simulci/commit/7f0239eefe155b1af5363acbb0bf19ee23bc2caa))
* **engine:** plan an untriggered workflow's jobs on request ([#46](https://github.com/ciatlas/simulci/issues/46)) ([be6d367](https://github.com/ciatlas/simulci/commit/be6d367ddc3faee2828dd594f7dc7b1b8f9d9ec9))
* **engine:** references of a job or a step for renames ([#48](https://github.com/ciatlas/simulci/issues/48)) ([af09f87](https://github.com/ciatlas/simulci/commit/af09f874a416afd9282c03328e5bc23ee04a4c2b))
* **web:** add a generated case to the workflow's test file ([#77](https://github.com/ciatlas/simulci/issues/77)) ([6565a57](https://github.com/ciatlas/simulci/commit/6565a573283f805cd49ab0b167425c7b4c4a3475))
* **web:** add, remove and connect jobs and steps on the canvas ([27028bb](https://github.com/ciatlas/simulci/commit/27028bbcdccfa34f7684acdf8f5ee9bea089507e))
* **web:** edit a job's steps and pick actions from a palette ([27028bb](https://github.com/ciatlas/simulci/commit/27028bbcdccfa34f7684acdf8f5ee9bea089507e))
* **web:** edit jobs and steps in the property panel ([68f20d6](https://github.com/ciatlas/simulci/commit/68f20d66034ac0f4a709bd0b63dd8cbd1c5a340a))
* **web:** edit the YAML in the pane ([117a76c](https://github.com/ciatlas/simulci/commit/117a76c78fa40712a7c268da03d5a45dd4aceee6))
* **web:** keep an untriggered workflow's jobs on the canvas while editing ([#62](https://github.com/ciatlas/simulci/issues/62)) ([e042eda](https://github.com/ciatlas/simulci/commit/e042eda329d65eb66a851943790cdc3df7bf0477))
* **web:** keep unsaved edits across reloads ([117a76c](https://github.com/ciatlas/simulci/commit/117a76c78fa40712a7c268da03d5a45dd4aceee6))
* **web:** one edit history with live re-simulation ([117a76c](https://github.com/ciatlas/simulci/commit/117a76c78fa40712a7c268da03d5a45dd4aceee6))
* **web:** rename a job or a step id with its references ([#76](https://github.com/ciatlas/simulci/issues/76)) ([3773ed3](https://github.com/ciatlas/simulci/commit/3773ed3ac35bce12a8ed4fb036fe28fed8a9c0a3))
* **web:** review changes and download a patch ([#63](https://github.com/ciatlas/simulci/issues/63)) ([e3906e2](https://github.com/ciatlas/simulci/commit/e3906e23e0da35a35f04657a56375f64b3593037))
* **web:** save edits back to the folder ([#70](https://github.com/ciatlas/simulci/issues/70)) ([b5bf16b](https://github.com/ciatlas/simulci/commit/b5bf16b028cbd15919638f2fe840f2f3833e7dd3))
* **web:** say what an edit changed ([#64](https://github.com/ciatlas/simulci/issues/64)) ([fcaf930](https://github.com/ciatlas/simulci/commit/fcaf9307e5e4e90dcc8ce044f72e89fe1b0d437f))
* **web:** the action palette and the bundled catalog ([#75](https://github.com/ciatlas/simulci/issues/75)) ([63452a3](https://github.com/ciatlas/simulci/commit/63452a33092f0af6943ba7fdcaf87bf6ae6b11b2))
* **web:** the edit runtime ([68f20d6](https://github.com/ciatlas/simulci/commit/68f20d66034ac0f4a709bd0b63dd8cbd1c5a340a))
* **web:** the matrix editor ([#69](https://github.com/ciatlas/simulci/issues/69)) ([f84dcb3](https://github.com/ciatlas/simulci/commit/f84dcb354c0b33a16151c03302c11f0140396480))
* **web:** the triggers editor ([#68](https://github.com/ciatlas/simulci/issues/68)) ([b584075](https://github.com/ciatlas/simulci/commit/b584075878629c4170005845736d7eb4a78684b7))


### Bug Fixes

* **web:** drop 'unsafe-inline' from the CSP's style-src ([#43](https://github.com/ciatlas/simulci/issues/43)) ([f24586b](https://github.com/ciatlas/simulci/commit/f24586be209adf8193878c74765dfc6cd6c669ca))
* **web:** name every undo entry in the past tense, and tidy three labels ([#86](https://github.com/ciatlas/simulci/issues/86)) ([75beab9](https://github.com/ciatlas/simulci/commit/75beab99ba01c32cd7e525577b1ad109d176c897))
* **web:** open the YAML pane from a bar under the plan, and on entering edit mode ([#74](https://github.com/ciatlas/simulci/issues/74)) ([1ded05d](https://github.com/ciatlas/simulci/commit/1ded05d7f6f08492e964e771f493399de5a01912))
* **web:** read files byte-exact ([#50](https://github.com/ciatlas/simulci/issues/50)) ([c430aa9](https://github.com/ciatlas/simulci/commit/c430aa9132c8d62b49bdef0f480b02ca1f38939b))


### Performance

* **web:** lay a card out again only when its width bucket changes ([f12eddc](https://github.com/ciatlas/simulci/commit/f12eddc4e283eed4e685a9a45a08b7f464a8c133))
* **web:** load the changes and save dialogs on demand ([#73](https://github.com/ciatlas/simulci/issues/73)) ([2609c7b](https://github.com/ciatlas/simulci/commit/2609c7b859b46cda4f832fe4b23abfcc47639baa))
* **web:** reuse run settings and on: lines across loads ([#51](https://github.com/ciatlas/simulci/issues/51)) ([f534f62](https://github.com/ciatlas/simulci/commit/f534f62a5bb99244cb416982afee351285e8eadf))

## [0.3.0](https://github.com/ciatlas/simulci/compare/v0.2.0...v0.3.0) (2026-10-20)


### Features

* **docs:** the docs site ([#37](https://github.com/ciatlas/simulci/issues/37)) ([d793a91](https://github.com/ciatlas/simulci/commit/d793a915b6ae3564671831fe42d29e80215ff533))
* **docs:** the reference pages ([461f06f](https://github.com/ciatlas/simulci/commit/461f06f992890e17d8168a4f4e1f86a9bcccaca2))
* **web:** copy a plan as a test case ([#32](https://github.com/ciatlas/simulci/issues/32)) ([a1a3441](https://github.com/ciatlas/simulci/commit/a1a34416da18b0b467ea007bb7e2faade706fa31))
* **web:** the accessibility pass ([#33](https://github.com/ciatlas/simulci/issues/33)) ([6745d8b](https://github.com/ciatlas/simulci/commit/6745d8b2b40deecbaaa2b6fd83246b77c9dafce6))


### Bug Fixes

* **cli:** keep every value of a repeated flag, and exit 2 on bad input ([461f06f](https://github.com/ciatlas/simulci/commit/461f06f992890e17d8168a4f4e1f86a9bcccaca2))
* **cli:** refuse unknown flag values, show kebab-case flags, exit 2 on errors ([#42](https://github.com/ciatlas/simulci/issues/42)) ([301dadf](https://github.com/ciatlas/simulci/commit/301dadf594cbd40358b299c33041da9def1eff10))

## [0.2.0](https://github.com/ciatlas/simulci/compare/v0.1.0...v0.2.0) (2026-10-19)


### Features

* **engine:** assume pins and producers for step and job unknowns ([#31](https://github.com/ciatlas/simulci/issues/31)) ([d737c57](https://github.com/ciatlas/simulci/commit/d737c5762080c44ad18d485cf522692f0dc97da8))
* **web:** reasons, unknowns, pins and the YAML pane ([#30](https://github.com/ciatlas/simulci/issues/30)) ([3eb4434](https://github.com/ciatlas/simulci/commit/3eb44340065bdbf48cd19c2fdf88e805f027ae76))
* **web:** sources, state and the plan as text ([#23](https://github.com/ciatlas/simulci/issues/23)) ([fdfe7e7](https://github.com/ciatlas/simulci/commit/fdfe7e7716fda183b7ac3141f848d91ead4fe3b7))
* **web:** the app skeleton, the engine in a Web Worker ([#19](https://github.com/ciatlas/simulci/issues/19)) ([b65cfed](https://github.com/ciatlas/simulci/commit/b65cfedb54f6ce364d83f11766617967b10166fc))
* **web:** the engine protocol and client ([#22](https://github.com/ciatlas/simulci/issues/22)) ([8af810d](https://github.com/ciatlas/simulci/commit/8af810d538e54b547ef6661bdbb55fcf59bf2344))
* **web:** the run graph ([#27](https://github.com/ciatlas/simulci/issues/27)) ([42f7175](https://github.com/ciatlas/simulci/commit/42f7175c6dfa56c1611fde84cf53ae50364f6985))
* **web:** the scenario form with hints ([#26](https://github.com/ciatlas/simulci/issues/26)) ([367c53a](https://github.com/ciatlas/simulci/commit/367c53ab43f693d499d000fed773d8109119d979))


### Performance

* **web:** lay out independent graph scopes together ([#28](https://github.com/ciatlas/simulci/issues/28)) ([f767464](https://github.com/ciatlas/simulci/commit/f767464548d332196a516f71c1e94de5c03a5c3b))
* **web:** warm ELK before the first layout ([#29](https://github.com/ciatlas/simulci/issues/29)) ([8d68909](https://github.com/ciatlas/simulci/commit/8d689099ea2c30afaa027ce59130ce71b796a005))

## 0.1.0 (2026-10-18)


### Features

* **action:** the simulci GitHub Action and the npm release ([#15](https://github.com/ciatlas/simulci/issues/15)) ([c363eee](https://github.com/ciatlas/simulci/commit/c363eee7ccb302a05bad572e0794698ae78a16d2))
* **engine:** mocks with interface validation and fail-fast ([#9](https://github.com/ciatlas/simulci/issues/9)) ([e90bf5e](https://github.com/ciatlas/simulci/commit/e90bf5e32aaf872268d090aee68ea0c7a549532f))
* **engine:** node selection, deciding reasons and canonical plans ([#10](https://github.com/ciatlas/simulci/issues/10)) ([2b89fef](https://github.com/ciatlas/simulci/commit/2b89fef37410ad91301d1ae33797947732a62429))
* **engine:** scenario schema and run-settings adapter ([003c6d1](https://github.com/ciatlas/simulci/commit/003c6d1b591379426b0c2dec6df7b54d0c16df8f))
* **engine:** scenario schema and run-settings adapter ([dea159b](https://github.com/ciatlas/simulci/commit/dea159b0dc6afde4f7facc388c992cd9c34ab295))
* **engine:** the planner and simulci plan ([#4](https://github.com/ciatlas/simulci/issues/4)) ([5cc6f2b](https://github.com/ciatlas/simulci/commit/5cc6f2b51ab55c404bedf9061f8dad56167c40ad))
* **engine:** the route-test runner ([#11](https://github.com/ciatlas/simulci/issues/11)) ([6004693](https://github.com/ciatlas/simulci/commit/6004693d47f94510039ae9ae1f9778b8ae348942))
* **engine:** trigger and filter semantics ([#6](https://github.com/ciatlas/simulci/issues/6)) ([1182903](https://github.com/ciatlas/simulci/commit/1182903772a9c56447e1703b6c578a834602c3e1))
