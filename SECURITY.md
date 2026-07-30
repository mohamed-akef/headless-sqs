# Security Policy

## Supported versions

| Version | Supported                             |
| ------- | ------------------------------------- |
| 1.x     | Yes                                   |
| 0.1.x   | No — pre-release, superseded by 1.0.0 |

## Reporting a vulnerability

Please **do not** open a public issue for a security problem.

Use GitHub's [private vulnerability reporting](https://github.com/mohamed-akef/headless-sqs/security/advisories/new) instead. Include the affected version, what an attacker can do, and a reproduction if you have one. You can expect an initial response within a week.

## Scope

This package is a client library: it holds no credentials of its own and stores nothing. Credentials and network configuration come from the `@aws-sdk/client-sqs` client you supply, so AWS credential handling is outside this project's scope — report those to [AWS](https://aws.amazon.com/security/vulnerability-reporting/).

Things that _are_ in scope:

- Message content or queue URLs appearing in logs or error messages.
- Provisioning behaviour that grants broader access than configured — for example an unintended queue policy or a queue created without requested encryption.
- Attribute reconciliation modifying a queue beyond what was configured.

## Notes for users

- `createIfNotExists` and `reconcileAttributes` are both off by default; each one lets this library modify your AWS account, so enable them deliberately and grant only the IAM permissions listed in the README.
- The default logger is silent. If you supply one, remember that message bodies may contain personal data — this library logs message _ids_ rather than bodies, but your own handler is your responsibility.
