# SSH-accessible Ubuntu lab image. Docker and NVIDIA integration live only on the host; this image
# deliberately contains no Docker daemon, Docker CLI, containerd, Docker socket, or NVIDIA runtime.
# Students retain sudo, while the outer daemon's userns-remap maps container root to an unprivileged
# host uid. Bubblewrap is installed as a normal (non-setuid) binary for Codex's Linux sandbox.

FROM ubuntu:noble@sha256:786a8b558f7be160c6c8c4a54f9a57274f3b4fb1491cf65146521ae77ff1dc54

ARG CODEX_VERSION=0.142.4
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        systemd systemd-sysv dbus openssh-server sudo \
        python3-pip python3-venv \
        bubblewrap uidmap libseccomp2 \
        git ripgrep curl ca-certificates procps util-linux nano gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install --global "@openai/codex@${CODEX_VERSION}" \
    && chmod 0755 /usr/bin/bwrap \
    && test ! -u /usr/bin/bwrap \
    && rm -rf /var/lib/apt/lists/* /root/.npm

# Password SSH remains the initial access mechanism; root login is disabled. Every container creates
# unique host keys on first boot.
RUN sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?MaxAuthTries.*/MaxAuthTries 3/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?LoginGraceTime.*/LoginGraceTime 30/' /etc/ssh/sshd_config \
    && printf '\nPermitRootLogin no\nMaxAuthTries 3\nLoginGraceTime 30\n' >> /etc/ssh/sshd_config \
    && passwd -l root \
    && mkdir -p /fast /cold \
    && rm -f /etc/ssh/ssh_host_*

COPY labquota /usr/local/bin/labquota
COPY ssh-hostkeys.service /etc/systemd/system/ssh-hostkeys.service

RUN chmod 0755 /usr/local/bin/labquota \
    && systemctl enable ssh ssh-hostkeys \
    && systemctl mask systemd-udevd.service systemd-udevd-kernel.socket \
        systemd-udevd-control.socket systemd-modules-load.service \
        sys-kernel-debug.mount sys-kernel-tracing.mount

EXPOSE 22
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
