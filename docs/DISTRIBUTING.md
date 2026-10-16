# Distributing Face Guard

There are two ways to get Face Guard onto other people's computers without scary warnings. You can do either or both.

| | Microsoft Store (MSIX) | Download from your site / GitHub (installer .exe) |
|---|---|---|
| Cost | Free (individual developer account) | About $10/month (Azure Artifact Signing) or a code-signing certificate |
| Trusted by Windows | Yes. Microsoft signs the package when it's published. | Only once the installer is code-signed. Unsigned installers trigger a SmartScreen warning. |
| Updates | Automatic, through the Store | Users download the new installer |
| Uninstall | Settings → Apps, or right-click in Start → Uninstall | Settings → Apps, the Uninstall button in Face Guard's settings, or the uninstaller in the install folder |
| Build command | `npm run dist:store` | `npm run dist` |

**Recommendation:** start with the Store. It's free, it's the only route where Windows fully trusts the app from day one, and anyone can install it with one click.

---

## What's already set up

- **Uninstaller** (installer build). It's registered in *Settings → Apps → Installed apps*, the app has its own *Settings → Uninstall…* button, and there's an `Uninstall Face Guard.exe` in the install folder. On uninstall it:
  - removes the "start with Windows" entry,
  - asks whether to delete settings and touch history (default: keep them),
  - leaves both alone when a newer version is installed over the old one.
- **Setup wizard.** It shows the license, lets the user choose an install location, and installs just for the current user by default, so no admin rights are needed.
- **Store package.** Tiles and logos are in `build/appx/`. It declares the webcam capability, and "start with Windows" is registered as a Windows startup task that users control in *Settings → Apps → Startup*.
- **Store-aware app.** In the Store version, Face Guard hands startup and uninstall to Windows. The in-app buttons open the right Windows settings pages.
- **Privacy policy.** It's at `src/renderer/public/privacy.html` and linked from the app's settings. The GitHub Pages deploy publishes it at `https://<you>.github.io/<repo>/privacy.html`, and that URL is what the Store asks for.
- **Signing hooks.** `electron-builder.config.cjs` signs the installer automatically when Azure Artifact Signing or certificate environment variables are present. The release workflow passes them in from GitHub secrets.
- **Safe defaults for other people.** *Consequences* (sign out / lock) is **off** for new installs. It's opt-in.
- **Release builds refuse to build without all three models,** so every copy works offline.

---

## Option A: Microsoft Store (free)

### 1. Create a developer account
Go to <https://storedeveloper.microsoft.com> and sign up as an **individual**. Registration is free. You verify with a government ID and a selfie.

### 2. Reserve the app name
In **Partner Center → Apps and games → New product → MSIX or PWA app**, reserve **Face Guard**. If that name is taken, try something like *Face Guard: Touch Alert* or *HandsOff: Face Touch Alert*. If you change the name, also update `displayName` in `electron-builder.config.cjs`.

### 3. Copy the product identity
In your new app, open **Product management → Product identity** and copy these three values into `build/store-identity.json`:

| Partner Center | store-identity.json |
|---|---|
| Package/Identity/Name | `identityName` |
| Package/Identity/Publisher (`CN=…`) | `publisher` |
| Package/Properties/PublisherDisplayName | `publisherDisplayName` |

### 4. Build the package
```powershell
npm run fetch-models
npm run dist:store      # -> release\FaceGuard-1.0.0-Store.appx
```

### 5. (Optional) Test the package on your PC before submitting
Windows only installs signed packages, so for a local test, sign it with a throwaway certificate. The subject must equal the `publisher` value. Run in PowerShell:

```powershell
$publisher = "CN=REPLACE-WITH-PUBLISHER-ID"   # exactly as in build/store-identity.json
$cert = New-SelfSignedCertificate -Type Custom -Subject $publisher -KeyUsage DigitalSignature `
  -FriendlyName "Face Guard local test" -CertStoreLocation "Cert:\CurrentUser\My" `
  -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3", "2.5.29.19={text}")
$pw = ConvertTo-SecureString "test" -Force -AsPlainText
Export-PfxCertificate -Cert "Cert:\CurrentUser\My\$($cert.Thumbprint)" -FilePath "$env:TEMP\faceguard-test.pfx" -Password $pw

# Trust it once (run PowerShell as Administrator for this line):
Import-PfxCertificate -FilePath "$env:TEMP\faceguard-test.pfx" -CertStoreLocation Cert:\LocalMachine\TrustedPeople -Password $pw

$env:CSC_LINK = "$env:TEMP\faceguard-test.pfx"; $env:CSC_KEY_PASSWORD = "test"
npm run dist:store
Add-AppxPackage .\release\FaceGuard-1.0.0-Store.appx
```
Uninstall the test copy from Start → right-click **Face Guard** → Uninstall. Then clear the two variables (`Remove-Item Env:CSC_LINK, Env:CSC_KEY_PASSWORD`) before building the real Store package. The Store does its own signing.

### 6. Fill in the submission
- **Pricing and availability:** Free. Choose which markets.
- **Properties:** Category *Health & fitness* (or *Productivity*). Privacy policy URL: your GitHub Pages `privacy.html`. Answer **Yes** to "accesses, collects or transmits personal information". The camera image counts as personal information even though it never leaves the PC, and answering Yes is what makes the privacy policy URL required.
- **Age ratings:** complete the questionnaire. There's no user-generated content, no chat, no purchases.
- **Packages:** upload `release\FaceGuard-<version>-Store.appx`.
- **Submission options → Restricted capabilities:** the package uses `runFullTrust`. Explanation to paste:
  > Face Guard is a desktop (Electron) app. It needs full trust to run in the background from the system tray, show notifications and an always-on-top alert, and, only if the user turns it on, sign the user out or lock the PC after repeated alerts. All camera processing happens locally; nothing is uploaded.
- **Store listing:** see the draft below. You need at least one screenshot, 1366×768 or larger. Take them with Win+Shift+S while Face Guard is running.

### Store listing draft
**Short description:** Break the face-touching habit. Face Guard watches your webcam and nudges you when your hand stays on your face.

**Description:**
> Touching your face is a habit you barely notice, and it spreads germs, irritates skin and triggers breakouts. Face Guard notices for you.
>
> • Real-time detection: on-device AI tracks your face and hands and alerts you if a touch lasts longer than 2 seconds (adjustable).
> • Stays out of the way: lives in the system tray, keeps working while minimized, and can start with Windows.
> • Knows when you're drinking: sipping from a mug or water bottle doesn't count.
> • Private by design: video never leaves your PC. No accounts, no ads, no tracking.
> • Your rules: alert delay, repeat alerts, sensitivity, pop-up or Windows notifications, sounds, and daily stats.
> • Optional tough love: turn on Consequences to lock your PC or sign you out after repeated touches.
> • Pause any time (15 min, 1 hour, or until you resume). Pausing turns the camera off.

**Keywords:** face touching, habit, webcam, posture, health, acne, focus, reminder

---

## Option B: Signed installer for direct download

Without a signature, Windows SmartScreen says "Windows protected your PC", and users have to click *More info → Run anyway*. To remove that warning:

### Azure Artifact Signing (Microsoft's service, formerly "Trusted Signing")
1. You need a pay-as-you-go Azure subscription. The Basic tier is about $9.99/month. Identity validation for individuals is available in supported countries, including the US.
2. In the Azure portal, create an **Artifact Signing account**, complete **identity validation**, then create a **Public Trust certificate profile**.
3. Create an app registration (service principal) and give it the *Artifact Signing Certificate Profile Signer* role on the account.
4. Add these as GitHub repository secrets, or as environment variables for a local `npm run dist`:

| Secret | Value |
|---|---|
| `AZURE_SIGNING_ENDPOINT` | e.g. `https://eus.codesigning.azure.net` (your account's region) |
| `AZURE_SIGNING_ACCOUNT` | the signing account name |
| `AZURE_SIGNING_CERT_PROFILE` | the certificate profile name |
| `AZURE_SIGNING_PUBLISHER_NAME` | the name on the certificate, e.g. `Blake Jordan` |
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | the app registration |

5. Push a tag (`git tag v1.0.1 && git push --tags`). The release workflow builds and signs the installer and attaches it to a GitHub Release.

A traditional OV code-signing certificate also works: set `CSC_LINK` (path to the .pfx) and `CSC_KEY_PASSWORD`. Either way, SmartScreen can still show a warning for a brand-new signed app until it builds download reputation. That usually happens within days to a few weeks.

### Sharing before you sign
`npm run dist` still produces a working installer. Tell people to click **More info → Run anyway** the first time.

---

## Before every release
1. Bump `version` in `package.json`. The Store needs a higher version for every submission.
2. `npm test`, then `npm run dist` / `npm run dist:store`.
3. Install the new build over the old one and check that your settings and stats survived.
4. Uninstall and check that it's gone from *Settings → Apps* and from *Settings → Apps → Startup*.
