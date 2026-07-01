# SSH-accessible CUDA development lab. Docker/NVIDIA device integration lives on the host; this
# image contains the CUDA toolkit and libraries, but no Docker daemon, CLI, socket, or inner NVIDIA
# container runtime. Students retain password-authenticated sudo. Bubblewrap is setuid-root.

FROM nvidia/cuda:13.3.0-devel-ubuntu24.04@sha256:ef2203909e80b8b976cfc672f7e2ae2b00bc0e25c404ee86d89e10a3802f1c52

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        openssh-server sudo \
        python3-pip python3-venv \
        bubblewrap \
        build-essential cmake ninja-build pkg-config \
        git ripgrep curl ca-certificates procps util-linux nano gnupg \
    && chown root:root /usr/bin/bwrap \
    && chmod 4755 /usr/bin/bwrap \
    && test -u /usr/bin/bwrap \
    && nvcc --version \
    && printf '%s\n' '__global__ void kernel() {}' 'int main() { return 0; }' \
        > /tmp/cuda-smoke.cu \
    && nvcc -c /tmp/cuda-smoke.cu -o /tmp/cuda-smoke.o \
    && rm -f /tmp/cuda-smoke.cu /tmp/cuda-smoke.o \
    && rm -rf /var/lib/apt/lists/*

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
