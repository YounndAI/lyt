# Contributing to Lyt (Link Your Think™)

Thank you for your interest in contributing to Lyt, a YounndAI™ product by
MARLINK TRADING SRL.

> Lyt is in public **alpha**. The surface is moving quickly; please open an
> issue or a discussion before starting non-trivial work so we can confirm
> direction and avoid duplicated effort.

## External code contributions are temporarily closed

For the 0.20.16 release, this repository uses a **no-external-code** inbound-IP
gate. Issues, discussions, bug reports, and documentation feedback are welcome,
but MARLINK TRADING SRL will not merge code contributed by external parties
while this gate is active. Please do not open a code pull request expecting it
to be accepted.

We intend to reopen external code contributions after a CLA service is installed
and enforced on every pull request. At that point, contributors will need the
[Individual CLA](https://github.com/YounndAI/lyt/blob/main/CLA.md) or
[Entity CLA](https://github.com/YounndAI/lyt/blob/main/CLA-entity.md), as
applicable. The presence of those documents today does not mean CLA enforcement
is active.

## Maintainer code checklist

- [ ] Change is authored under the active no-external-code gate
- [ ] Apache-2.0 copyright header included in any new source files (see existing files for the exact block)
- [ ] Code follows existing project conventions (TypeScript strict mode, libSQL-only data layer, cross-platform paths)
- [ ] Focused tests added for new functionality; `npm run build`, `npm run typecheck`, and `npm test` green
- [ ] Documentation updated for user-facing changes
- [ ] Protected marks identified somewhere on the public surface (a footer or colophon is sufficient); see [TRADEMARK.md](TRADEMARK.md)
- [ ] CHANGELOG.md updated where the change is user-facing

## Code of conduct

We follow the [Contributor Covenant Code of Conduct](https://github.com/YounndAI/lyt/blob/main/CODE_OF_CONDUCT.md).
By contributing, you agree to abide by its terms.

## Questions?

- General questions: [GitHub Discussions](https://github.com/YounndAI/lyt/discussions)
- Legal questions: office@younndai.com
- Security questions: see [SECURITY.md](SECURITY.md)

Thank you for contributing!
