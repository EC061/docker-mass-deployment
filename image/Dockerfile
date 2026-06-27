# Default lab base image: an SSH-accessible Ubuntu running systemd, with sudo, Python, and a full
# Docker engine for nested containers.
#
# Lab containers run under the Sysbox runtime (--runtime=sysbox-runc), which provides
# Docker-in-Docker WITHOUT --privileged and remaps container-root to an UNPRIVILEGED host UID — so
# the in-container Docker daemon and per-user sudo cannot reach host root. GPUs are injected at run
# time via the NVIDIA Container Device Interface (--device nvidia.com/gpu=all), independent of the
# OCI runtime, so they compose with sysbox-runc.
#
# systemd is PID 1 (Sysbox's supported pattern) so ssh and docker run as real services. Students are
# added later as Linux users by the agent (docker exec useradd ...), so this image does NOT create
# users at boot. The agent bind-mounts lab data at /labdata/{fast,slow} and per-student datasets
# under /labusers/{fast,slow}; the agent wires each student's ~/scratch and ~/cold-storage.
#
# Build + tag for use as a lab image:
#   docker build -t custom-ssh ./image
#
# This image is built ONCE and pinned/frozen for 1-2 years. Running containers are kept patched by
# the agent's weekly in-container `apt-get update && upgrade`, so the base image never needs a
# rebuild for security updates — patching is decoupled from the (frozen) image digest.

# Pinned by digest for reproducible builds (M-09); Dependabot bumps it, the tag comment stays readable.
FROM ubuntu:noble@sha256:786a8b558f7be160c6c8c4a54f9a57274f3b4fb1491cf65146521ae77ff1dc54

ENV DEBIAN_FRONTEND=noninteractive

# Base tooling: systemd (PID 1), SSH, sudo, Python.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        systemd systemd-sysv dbus \
        openssh-server sudo python3-pip python3-venv curl nano ca-certificates gnupg \
    && rm -rf /var/lib/apt/lists/*

# Docker engine (for nested containers), from Docker's official apt repo, pinned to the noble channel.
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" \
        > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*

# Harden sshd: students authenticate with passwords, but root login is off, brute force is throttled,
# and the login window is short. Instructors can still use key auth. (Per-user sudo is granted by the
# agent; it is safe only because Sysbox remaps container-root to an unprivileged host UID.)
RUN sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?MaxAuthTries.*/MaxAuthTries 3/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?LoginGraceTime.*/LoginGraceTime 30/' /etc/ssh/sshd_config \
    && printf '\nPermitRootLogin no\nMaxAuthTries 3\nLoginGraceTime 30\n' >> /etc/ssh/sshd_config \
    # Lock the root account password so it cannot be used for SSH/su.
    && passwd -l root \
    && mkdir -p /labdata /labusers \
    # Drop any host keys generated at install time so each container mints its own on first boot
    # (see ssh-hostkeys.service); otherwise every lab container would ship identical SSH host keys.
    && rm -f /etc/ssh/ssh_host_*

# `labquota`: students run this to see their (and labmates') storage usage. It only reads the usage
# snapshot the agent publishes under /labusers/fast/.labquota — no network, no privileges.
COPY labquota /usr/local/bin/labquota
# Oneshot unit: regenerate unique SSH host keys on first boot, before sshd starts.
COPY ssh-hostkeys.service /etc/systemd/system/ssh-hostkeys.service
RUN chmod +x /usr/local/bin/labquota \
    && systemctl enable ssh docker ssh-hostkeys \
    # Strip systemd units that are useless or noisy inside a container.
    && systemctl mask systemd-udevd.service systemd-udevd-kernel.socket systemd-udevd-control.socket \
        systemd-modules-load.service sys-kernel-debug.mount sys-kernel-tracing.mount

EXPOSE 22
# systemd as PID 1 (runs unprivileged under Sysbox); it brings up ssh + docker.
CMD ["/sbin/init"]
