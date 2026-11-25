# Setting up Sign in with Apple

Kolab offers Sign in with Apple beside GitHub (Lee, 2026-11-23). konnect's App Store listing needs it, because guideline 4.8 asks for it next to a third-party sign-in. The code is deployed. It stays off until Kolab has four things: a Services ID, the team id, a key id and the key itself. Until it has all four, Kolab logs `apple_sign_in_off` and offers GitHub alone. [`README.md`](../README.md) covers how it works (*Signing up and in*) and how it is deployed (*Deploying to AWS*).

**Who does what.** Lee does steps 1 to 3, in Apple's developer portal and from his own machine with the `icedlee337` profile. The private key never passes through Claude, a chat, a commit or a command line. Claude does step 4 through a pull request and a CI deploy (D73, D107). Only the Key ID passes between them, and it isn't secret.

| What | Value |
| --- | --- |
| Apple Developer team | `7Y8QD34KJQ`, already `apple_signin_team_id`'s default |
| Primary App ID | `com.konjir.kolab` ("Kolab sign-in"), which already has Sign in with Apple enabled |
| Services ID | `com.konjir.kolab.web` |
| Domain | `kolab.konjir.com` |
| Return URL | `https://kolab.konjir.com/oauth/callback/apple` |
| Where the key goes | SSM SecureString `/konjir/konjir-test/apple-signin-private-key`, in `us-east-1` |

## 1. Create the Services ID

The Services ID is the client that Kolab's web sign-in identifies itself as to Apple.

1. Open https://developer.apple.com/account, then **Certificates, Identifiers & Profiles**, then **Identifiers**. Click **+**.
2. Choose **Services IDs** and click **Continue**.
3. Fill in:
   - **Description:** `Kolab web sign-in`, which people see on Apple's sign-in screen.
   - **Identifier:** `com.konjir.kolab.web`.

   Click **Continue**, then **Register**.
4. Back in the list, switch its filter (top right) to **Services IDs** and open `com.konjir.kolab.web`.
5. Tick **Sign in with Apple** and click **Configure**:
   - **Primary App ID:** `com.konjir.kolab`
   - **Domains and Subdomains:** `kolab.konjir.com`
   - **Return URLs:** `https://kolab.konjir.com/oauth/callback/apple`
6. Click **Next**, then **Done**, then **Continue**, then **Save**.

The return URL must match exactly: `https`, no trailing slash. If it doesn't match, Apple refuses the sign-in with `invalid_request`.

## 2. Create the key

1. In the same portal, open **Keys** and click **+**.
2. **Key Name:** `Kolab Sign in with Apple`. Tick **Sign in with Apple**, then click **Configure** next to it.
3. **Primary App ID:** `com.konjir.kolab`. Click **Save**, then **Continue**, then **Register**.
4. Click **Download**. That saves `AuthKey_<KEYID>.p8`. **Apple lets you download it only once.** If it is lost, revoke the key and make a new one, then do step 3 again and send the new Key ID.
5. Note the **Key ID**. It is the 10 characters shown on that page, and the same ones in the filename.

Keep the file out of the repository, for example beside the App Store Connect key, with only you able to read it:

```
mv ~/Downloads/AuthKey_<KEYID>.p8 ~/.config/konnect-mobile/ && chmod 600 ~/.config/konnect-mobile/AuthKey_<KEYID>.p8
```

## 3. Put the key where Kolab reads it

The command reads the key from the file, so it never appears on a command line or in the shell's history:

```
aws ssm put-parameter --profile icedlee337 --region us-east-1 \
  --name /konjir/konjir-test/apple-signin-private-key \
  --type SecureString --overwrite \
  --value file://$HOME/.config/konnect-mobile/AuthKey_<KEYID>.p8
```

To check that it is there, without printing it:

```
aws ssm describe-parameters --profile icedlee337 --region us-east-1 \
  --parameter-filters Key=Name,Values=/konjir/konjir-test/apple-signin-private-key \
  --query 'Parameters[].[Name,Type,LastModifiedDate]' --output table
```

Then send Claude the **Key ID**, and nothing else.

## 4. Turn it on (Claude)

1. A pull request sets the defaults of `apple_signin_services_id` to `com.konjir.kolab.web` and `apple_signin_key_id` to the Key ID, in `deploy/terraform`. Terraform keeps each value as a String parameter.
2. It is reviewed and merged, then deployed from CI. The plan should add two String parameters, `/konjir/konjir-test/apple-signin-services-id` and `-key-id` (`-team-id` is already there), and change nothing protected. When Kolab starts, the release's `start.sh` exports all four as `KONJIR_APPLE_*`.
3. Check it on production:
   - Kolab's log no longer says `apple_sign_in_off`.
   - `https://kolab.konjir.com/oauth/authorize`, when reached through a sign-in, shows Sign in with Apple above GitHub.
   - A sign-in with a test Apple Account reaches *choose a username*, then the consent page.
   - Signing in again goes straight through.
4. Then konnect 1.0.0 goes to App Review with Sign in with Apple live.

## If something goes wrong

- **Kolab still logs `apple_sign_in_off`.** One of the four values is missing, or the key can't be read. Check that the private key's parameter exists (step 3) and that the deploy added the `services-id` and `key-id` String parameters beside `team-id`.
- **Apple says `invalid_client`.** The Services ID, the team id or the key id doesn't match the key, or the key isn't enabled for Sign in with Apple under `com.konjir.kolab`.
- **Apple says `invalid_request` about the redirect.** The return URL in step 1.5 doesn't match `https://kolab.konjir.com/oauth/callback/apple` exactly.
- **The key leaked.** Revoke it under **Keys**, make a new one (step 2), put it in place (step 3) and send the new Key ID. Until a deploy with the new id, Apple sign-in fails, and GitHub sign-in is unaffected.
