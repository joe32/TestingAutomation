# Local Hostname Setup (`testing-automation.local`)

To access the runner dashboard from other devices, the machine running `runner.js`
must advertise its hostname via mDNS (`.local`).

## 1) Start runner with hostname mode

Mac (headed):

```bash
npm run runner:start:hostname
```

Orange Pi (headless):

```bash
npm run runner:start:headless:hostname
```

Dashboard URL:

```text
http://testing-automation.local:5050/ui
```

## 2) Ensure hostname resolves on LAN

### On Orange Pi (Debian/Ubuntu)

Install and enable mDNS daemon:

```bash
sudo apt update
sudo apt install -y avahi-daemon
sudo systemctl enable --now avahi-daemon
```

Set hostname:

```bash
sudo hostnamectl set-hostname testing-automation
```

Reboot (or restart networking) after changing hostname.

### On macOS

Set hostname:

```bash
sudo scutil --set HostName testing-automation
sudo scutil --set LocalHostName testing-automation
sudo scutil --set ComputerName "testing-automation"
```

Restart Wi-Fi or reboot after changing hostname.

## 3) Firewall note

If phone/other devices cannot connect, allow incoming connections for Terminal/Node
on the machine running the runner.
