FROM ubuntu:noble

# Install required packages, configure SSH, and create /var/run/sshd
RUN apt-get update && apt-get install -y openssh-server curl sudo python3-pip nano && rm -rf /var/lib/apt/lists/* \
    && sed -i 's/^#PasswordAuthentication yes/PasswordAuthentication yes/' /etc/ssh/sshd_config \
    && mkdir /var/run/sshd

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
CMD ["/usr/sbin/sshd", "-D"]
