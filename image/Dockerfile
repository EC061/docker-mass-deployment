# Default lab base image: an SSH-accessible Ubuntu running systemd, with sudo, Python, and ONE shared
# in-container Docker daemon for nested containers.
#
# The daemon's data-root is pinned to /labdata/fast/docker — the lab's shared fast tier, which the
# agent bind-mounts at run time. So all nested images/layers/containers live on big, persistent,
# quota-counted storage (and the layer cache is shared across the lab) instead of bloating the
# ephemeral container overlay. Storage driver is fuse-overlayfs because the data-root sits on a
# bind-mounted ZFS dataset, where overlay2 is not supported (see the validation note below).
#
# Nested Docker is meant to be a LAST RESORT: the lab container already has sudo, Python, and direct
# GPU access, so most work needs no inner container. When a project genuinely needs one, students run
# `docker` directly (they are in the `docker` group); STUDENT_GUIDE.md shows how to pass the GPU and
# bind-mount their own ~/scratch and ~/cold-storage into the inner container.
#
# Lab containers run under the Sysbox runtime (--runtime=sysbox-runc), which provides nested Docker
# WITHOUT --privileged and remaps container-root to an UNPRIVILEGED host UID — so the in-container
# Docker daemon (and per-user sudo) cannot reach host root. The daemon therefore runs root-IN-CONTAINER
# but is rootless/host-isolated from the host's point of view. GPUs reach the lab container via the
# NVIDIA Container Device Interface (--device nvidia.com/gpu=all), independent of the OCI runtime, so
# they compose with sysbox-runc; nvidia-container-toolkit is installed so the inner daemon can re-pass
# those GPUs into nested containers (CDI spec regenerated at boot by nvidia-cdi.service).
#
# systemd is PID 1 (Sysbox's supported pattern) so ssh + docker run as real services. Students are
# added later as Linux users by the agent (docker exec useradd ...), so this image does NOT create
# users at boot. The agent bind-mounts lab data at /labdata/{fast,slow} and per-student datasets under
# /labusers/{fast,slow}; the agent wires each student's ~/scratch and ~/cold-storage.
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
# fuse-overlayfs is the storage driver (data-root lives on a bind-mounted ZFS dataset; see daemon.json).
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" \
        > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin fuse-overlayfs \
    && rm -rf /var/lib/apt/lists/*

# NVIDIA Container Toolkit, so the in-container daemon can re-pass the lab container's GPUs into nested
# containers (via `--gpus all` or `--device nvidia.com/gpu=all`). The CDI spec is generated at boot.
RUN curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
        | gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg \
    && curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
        | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
        > /etc/apt/sources.list.d/nvidia-container-toolkit.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends nvidia-container-toolkit \
    && rm -rf /var/lib/apt/lists/*

# Pin the daemon's data-root to the lab's shared fast tier and select the fuse-overlayfs driver (the
# data-root is a bind-mounted ZFS dataset, where overlay2 is unsupported). CDI is enabled and the
# nvidia runtime registered so nested containers can request the GPU. The agent bind-mounts
# /labdata/fast at run time; Docker creates /labdata/fast/docker on first start.
RUN mkdir -p /etc/docker \
    && printf '%s\n' \
        '{' \
        '  "data-root": "/labdata/fast/docker",' \
        '  "storage-driver": "fuse-overlayfs",' \
        '  "features": { "cdi": true },' \
        '  "runtimes": { "nvidia": { "path": "nvidia-container-runtime", "runtimeArgs": [] } }' \
        '}' \
        > /etc/docker/daemon.json

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
# Oneshot unit: generate the inner NVIDIA CDI spec (if GPUs present) before docker starts.
COPY nvidia-cdi.service /etc/systemd/system/nvidia-cdi.service
RUN chmod +x /usr/local/bin/labquota \
    && systemctl enable ssh docker ssh-hostkeys nvidia-cdi \
    # Strip systemd units that are useless or noisy inside a container.
    && systemctl mask systemd-udevd.service systemd-udevd-kernel.socket systemd-udevd-control.socket \
        systemd-modules-load.service sys-kernel-debug.mount sys-kernel-tracing.mount

EXPOSE 22
# systemd as PID 1 (runs unprivileged under Sysbox); it brings up ssh + the shared docker daemon.
CMD ["/sbin/init"]
