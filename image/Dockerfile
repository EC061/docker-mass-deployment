# SSH-accessible Ubuntu lab image. Docker and NVIDIA integration live only on the host; this image
# deliberately contains no Docker daemon, Docker CLI, containerd, Docker socket, or NVIDIA runtime.
# Students retain sudo. Docker userns-remap is disabled on managed nodes so setuid-root binaries
# keep their real root ownership. Bubblewrap is installed setuid-root for reliable nested sandboxing.

FROM ubuntu:noble@sha256:786a8b558f7be160c6c8c4a54f9a57274f3b4fb1491cf65146521ae77ff1dc54

ARG CODEX_VERSION=0.142.4
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        openssh-server sudo \
        python3-pip python3-venv \
        bubblewrap uidmap libseccomp2 \
        git ripgrep curl ca-certificates procps util-linux nano gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install --global "@openai/codex@${CODEX_VERSION}" \
    && chown root:root /usr/bin/bwrap \
    && chmod 4755 /usr/bin/bwrap \
    && test -u /usr/bin/bwrap \
    && rm -rf /var/lib/apt/lists/* /root/.npm

# Keep the pinned system Codex as a baseline while allowing its student-run in-app updater to
# install a newer global package into the persistent home without sudo.
RUN printf '%s\n' 'prefix=${HOME}/.local' > /etc/npmrc \
    && printf '%s\n' \
        'export NPM_CONFIG_PREFIX="$HOME/.local"' \
        'export PATH="$HOME/.local/bin:$PATH"' \
        > /etc/profile.d/lab-npm-user-prefix.sh \
    && printf '%s\n' '. /etc/profile.d/lab-npm-user-prefix.sh' >> /etc/bash.bashrc \
    && chmod 0644 /etc/npmrc /etc/profile.d/lab-npm-user-prefix.sh

# Password SSH remains the initial access mechanism; root login is disabled. Every container creates
# unique host keys on first boot.
RUN sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?MaxAuthTries.*/MaxAuthTries 3/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?LoginGraceTime.*/LoginGraceTime 30/' /etc/ssh/sshd_config \
    && printf '\nPermitRootLogin no\nMaxAuthTries 3\nLoginGraceTime 30\n' >> /etc/ssh/sshd_config \
    && passwd -l root \
    && mkdir -p /home /cold-storage \
    && rm -f /etc/ssh/ssh_host_*

COPY labquota /usr/local/bin/labquota
COPY entrypoint /usr/local/sbin/lab-entrypoint

RUN chmod 0755 /usr/local/bin/labquota /usr/local/sbin/lab-entrypoint

EXPOSE 22
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/sbin/lab-entrypoint"]
